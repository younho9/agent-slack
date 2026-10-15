import type { SlackApiClient } from "./client.ts";
import { renderSlackMessageContent } from "./render.ts";
import { extractMrkdwnFromRichTextBlock } from "./render-rich-text.ts";

export type LaterItem = {
  item_type: string;
  channel_id?: string;
  channel_name?: string;
  ts?: string;
  state: string;
  todo_state?: string;
  date_saved: number;
  date_due?: number;
  date_completed?: number;
  message?: {
    author?: { user_id?: string; bot_id?: string };
    content?: string;
    thread_ts?: string;
    reply_count?: number;
  };
};

type LaterState = "in_progress" | "archived" | "completed" | "all";

// saved.list returns only one bucket per call, selected by `filter`.
// Without it, only uncompleted saved messages come back (Slack's To-dos rollout, 2026-10).
const SAVED_LIST_FILTERS: Record<LaterState, string[]> = {
  in_progress: ["saved", "todo"],
  archived: ["archived"],
  completed: ["completed"],
  all: ["saved", "todo", "completed", "archived"],
};

const LISTED_ITEM_TYPES = new Set(["message", "reminder"]);

export async function fetchLaterItems(
  client: SlackApiClient,
  options?: {
    state?: LaterState;
    limit?: number;
    maxBodyChars?: number;
    countsOnly?: boolean;
    cursor?: string;
  },
): Promise<{
  counts: {
    in_progress: number;
    todo: number;
    archived: number;
    completed: number;
    total: number;
  };
  items: LaterItem[];
  next_cursor?: string;
}> {
  const stateFilter = options?.state ?? "in_progress";
  const limit = options?.limit ?? 20;
  const maxBodyChars = options?.maxBodyChars ?? 4000;
  const countsOnly = options?.countsOnly ?? false;
  const filters = SAVED_LIST_FILTERS[stateFilter];
  // A cursor belongs to a single filter's result set.
  const singleFilter = filters.length === 1;

  // `filter` already buckets by state server-side; To-do items may carry their own state values.
  const matches = (item: Record<string, unknown>): boolean =>
    LISTED_ITEM_TYPES.has(getString(item.item_type) ?? "");

  const seen = new Set<string>();
  const allRawItems: Record<string, unknown>[] = [];
  let counts: Record<string, unknown> | undefined;
  let nextCursor: string | undefined;

  for (const filter of filters) {
    let currentCursor = singleFilter ? options?.cursor : undefined;
    while (true) {
      const resp = await client.api("saved.list", {
        limit: 50,
        filter,
        cursor: currentCursor,
      });

      counts ??= isRecord(resp.counts) ? resp.counts : {};
      if (countsOnly) {
        break;
      }

      for (const item of asArray(resp.saved_items).filter(isRecord)) {
        const key = `${getString(item.item_type)}:${getString(item.item_id)}:${getString(item.ts)}`;
        if (!seen.has(key)) {
          seen.add(key);
          allRawItems.push(item);
        }
      }

      const meta = isRecord(resp.response_metadata) ? resp.response_metadata : null;
      const cursor = meta ? getString(meta.next_cursor) : undefined;
      nextCursor = singleFilter ? cursor : undefined;

      if (allRawItems.filter(matches).length >= limit || !cursor) {
        break;
      }
      currentCursor = cursor;
    }
    if (countsOnly || allRawItems.filter(matches).length >= limit) {
      break;
    }
  }

  counts ??= {};
  const result = {
    counts: {
      in_progress: getNumber(counts.uncompleted_count) ?? 0,
      todo: getNumber(counts.todo_count) ?? 0,
      archived: getNumber(counts.archived_count) ?? 0,
      completed: getNumber(counts.completed_count) ?? 0,
      total: getNumber(counts.total_count) ?? 0,
    },
    items: [] as LaterItem[],
    next_cursor: nextCursor,
  };

  if (countsOnly) {
    return result;
  }

  const filtered = allRawItems.filter(matches).slice(0, limit);

  // Hydrate items in parallel
  result.items = await Promise.all(
    filtered.map(async (item) => {
      const itemType = getString(item.item_type) ?? "message";
      const state = getString(item.state) ?? "in_progress";
      const dateSaved = getNumber(item.date_created) ?? 0;
      const dateCompleted = getNumber(item.date_completed);
      const dateDue = getNumber(item.date_due);
      const common = {
        item_type: itemType,
        state,
        todo_state: getString(item.todo_state),
        date_saved: dateSaved,
        date_due: dateDue && dateDue > 0 ? dateDue : undefined,
        date_completed: dateCompleted && dateCompleted > 0 ? dateCompleted : undefined,
      };

      // Standalone To-dos (reminders) carry their text inline and have no channel.
      if (itemType === "reminder") {
        const content = truncate(
          asArray(item.description).map(extractMrkdwnFromRichTextBlock).join("\n\n"),
          maxBodyChars,
        );
        return {
          ...common,
          message: content ? { content } : undefined,
        } satisfies LaterItem;
      }

      const channelId = getString(item.item_id) ?? "";
      const ts = getString(item.ts) ?? "";

      let channelName: string | undefined;
      let message: LaterItem["message"];

      // Resolve channel name
      try {
        const info = await client.api("conversations.info", {
          channel: channelId,
        });
        const ch = isRecord(info.channel) ? info.channel : null;
        if (ch) {
          channelName = getString(ch.name) ?? getString(ch.name_normalized) ?? undefined;

          // For DMs, resolve user display name
          if (ch.is_im && !channelName) {
            const userId = getString(ch.user);
            if (userId) {
              try {
                const userInfo = await client.api("users.info", { user: userId });
                const u = isRecord(userInfo.user) ? userInfo.user : null;
                const profile = u && isRecord(u.profile) ? u.profile : null;
                channelName =
                  getString(profile?.display_name) ||
                  getString(u?.real_name) ||
                  getString(u?.name) ||
                  undefined;
              } catch {
                // ignore
              }
            }
          }
        }
      } catch {
        // ignore
      }

      // Fetch the actual message
      if (ts) {
        try {
          const history = await client.api("conversations.history", {
            channel: channelId,
            latest: ts,
            inclusive: true,
            limit: 1,
          });
          const msgs = asArray(history.messages).filter(isRecord);
          const msg = msgs.find((m) => getString(m.ts) === ts);
          if (msg) {
            const content = truncate(renderSlackMessageContent(msg), maxBodyChars);

            message = {
              author:
                getString(msg.user) || getString(msg.bot_id)
                  ? {
                      user_id: getString(msg.user) ?? undefined,
                      bot_id: getString(msg.bot_id) ?? undefined,
                    }
                  : undefined,
              content: content || undefined,
              thread_ts: getString(msg.thread_ts) ?? undefined,
              reply_count: getNumber(msg.reply_count) ?? undefined,
            };
          }
        } catch {
          // ignore — message may have been deleted
        }
      }

      return {
        ...common,
        channel_id: channelId,
        channel_name: channelName,
        ts,
        message,
      } satisfies LaterItem;
    }),
  );

  return result;
}

/**
 * Mark a saved item as completed, archived, or reopen it.
 * Uses multipart/form-data with the `mark` param (not `state`).
 * Valid `mark` values: completed, uncompleted, archived, unarchived.
 */
export async function updateLaterMark(
  client: SlackApiClient,
  input: {
    channelId: string;
    ts: string;
    mark: "completed" | "uncompleted" | "archived" | "unarchived";
  },
): Promise<void> {
  await client.apiMultipart("saved.update", {
    item_id: input.channelId,
    item_type: "message",
    ts: input.ts,
    mark: input.mark,
  });
}

export async function saveLater(
  client: SlackApiClient,
  input: { channelId: string; ts: string },
): Promise<void> {
  await client.api("saved.add", {
    item_id: input.channelId,
    item_type: "message",
    ts: input.ts,
  });
}

export async function removeLater(
  client: SlackApiClient,
  input: { channelId: string; ts: string },
): Promise<void> {
  await client.api("saved.delete", {
    item_id: input.channelId,
    item_type: "message",
    ts: input.ts,
  });
}

export async function setLaterReminder(
  client: SlackApiClient,
  input: { channelId: string; ts: string; dateDue: number },
): Promise<void> {
  await client.apiMultipart("saved.update", {
    item_id: input.channelId,
    item_type: "message",
    ts: input.ts,
    date_due: String(input.dateDue),
  });
}

export function parseReminderDuration(input: string): number {
  const now = Math.floor(Date.now() / 1000);
  const trimmed = input.trim().toLowerCase();

  // Relative durations: 30m, 1h, 3h, 2d, 1.5h
  const relMatch = trimmed.match(
    /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/,
  );
  if (relMatch) {
    const amount = Number.parseFloat(relMatch[1]!);
    const unit = relMatch[2]!.charAt(0);
    if (unit === "m") {
      return now + amount * 60;
    }
    if (unit === "h") {
      return now + amount * 3600;
    }
    if (unit === "d") {
      return now + amount * 86400;
    }
  }

  // Named times
  const tomorrow9am = getNext9am(1);
  if (trimmed === "tomorrow") {
    return tomorrow9am;
  }

  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayIndex = dayNames.indexOf(trimmed);
  if (dayIndex >= 0) {
    const today = new Date();
    const currentDay = today.getDay();
    let daysUntil = dayIndex - currentDay;
    if (daysUntil <= 0) {
      daysUntil += 7;
    }
    return getNext9am(daysUntil);
  }

  // Unix timestamp passthrough
  const asNum = Number(trimmed);
  if (!Number.isNaN(asNum) && asNum > 1000000000) {
    return asNum;
  }

  throw new Error(
    `Invalid duration: "${input}". Use: 30m, 1h, 3h, 2d, tomorrow, monday, or a unix timestamp.`,
  );
}

function getNext9am(daysFromNow: number): number {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(9, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function truncate(text: string, maxChars: number): string {
  return maxChars >= 0 && text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

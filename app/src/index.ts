/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const THREAD_URLS_VARIABLE = 'STEAM_THREAD_URLS';
const DISCORD_WEBHOOK_URL_VARIABLE = 'DISCORD_WEBHOOK_URL';

type WorkerEnv = Env & {
  STEAM_THREAD_URLS?: string;
  DISCORD_WEBHOOK_URL?: string;
};

const lastKnownCounts = new Map<string, number>();

export default {
  async fetch(): Promise<Response> {
    return new Response('Steam discussion watcher is running.');
  },

  async scheduled(_event, env, ctx): Promise<void> {
    const workerEnv = env as WorkerEnv;
    const urls = parseThreadUrls(workerEnv[THREAD_URLS_VARIABLE]);
    const webhookUrl = workerEnv[DISCORD_WEBHOOK_URL_VARIABLE];

    if (urls.length === 0) {
      console.warn('No Steam thread URLs configured. Skipping scheduled run.');
      return;
    }

    if (!webhookUrl) {
      console.warn('No Discord webhook URL configured. Skipping scheduled run.');
      return;
    }

    const tasks = urls.map((url) => handleThread(url, webhookUrl));
    for (const task of tasks) {
      ctx.waitUntil(task);
    }
    await Promise.all(tasks);
  },
} satisfies ExportedHandler<Env>;

async function handleThread(url: string, webhookUrl: string): Promise<void> {
  try {
    const postCount = await fetchPostCount(url);
    const previousCount = lastKnownCounts.get(url);

    if (typeof previousCount !== 'number') {
      lastKnownCounts.set(url, postCount);
      console.log(`Stored initial post count for ${url}: ${postCount}`);
      return;
    }

    if (postCount > previousCount) {
      const difference = postCount - previousCount;
      const formattedDifference = new Intl.NumberFormat('ja-JP').format(difference);
      const formattedTotal = new Intl.NumberFormat('ja-JP').format(postCount);
      await notifyDiscord(webhookUrl, {
        content: `📢 新しい書き込みがありました (+${formattedDifference} 件 / 合計 ${formattedTotal} 件)\n${url}`,
      });
      console.log(`Notified Discord about ${difference} new posts for ${url}.`);
    } else if (postCount < previousCount) {
      console.warn(
        `Detected a decrease in post count for ${url} (was ${previousCount}, now ${postCount}).`,
      );
    } else {
      console.log(`No new posts detected for ${url}.`);
    }

    lastKnownCounts.set(url, postCount);
    console.log(`Updated post count for ${url}: ${postCount}`);
  } catch (error) {
    console.error(`Failed to process ${url}:`, error);
  }
}

async function fetchPostCount(url: string): Promise<number> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'steam-discussion-watcher/1.0 (+https://workers.cloudflare.com/)',
      Accept: 'text/html,application/xhtml+xml',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch thread (${response.status} ${response.statusText})`);
  }

  const body = await response.text();
  const count = extractPostCount(body);

  if (count === null) {
    throw new Error('Unable to locate post count in thread HTML.');
  }

  return count;
}

function extractPostCount(html: string): number | null {
  const patterns = [
    /<span[^>]*class="commentthread_count_label"[^>]*>\s*([\d,.]+)\s*<\/span>/i,
    /"comment_count"\s*:\s*(\d+)/i,
    /"num_comments"\s*:\s*(\d+)/i,
    /"total_count"\s*:\s*(\d+)/i,
    /data-tooltip-content="[^"]*?([\d,.]+)\s*(?:comments|件のコメント)/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      const parsed = Number(match[1].replace(/[,.]/g, ''));
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function parseThreadUrls(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    }
  } catch (error) {
    console.warn('Failed to parse Steam thread URLs as JSON. Falling back to delimiter parsing.', error);
  }

  return raw
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

interface DiscordWebhookPayload {
  content?: string;
  username?: string;
  embeds?: unknown[];
}

async function notifyDiscord(webhookUrl: string, payload: DiscordWebhookPayload): Promise<void> {
  if (!payload.content && (!payload.embeds || payload.embeds.length === 0)) {
    throw new Error('Discord webhook payload must include content or embeds.');
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '<failed to read response body>');
    throw new Error(`Failed to send Discord notification (${response.status} ${response.statusText}): ${errorText}`);
  }
}

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
const KV_KEY_PREFIX = 'thread:';

type WorkerEnv = Env & {
  STEAM_DISCUSSION_COUNTS: KVNamespace;
  STEAM_THREAD_URLS?: string;
};

export default {
  async fetch(): Promise<Response> {
    return new Response('Steam discussion watcher is running.');
  },

  async scheduled(_event, env, ctx): Promise<void> {
    const workerEnv = env as WorkerEnv;
    const urls = parseThreadUrls(workerEnv[THREAD_URLS_VARIABLE]);

    if (urls.length === 0) {
      console.warn('No Steam thread URLs configured. Skipping scheduled run.');
      return;
    }

    const tasks = urls.map((url) => handleThread(url, workerEnv));
    for (const task of tasks) {
      ctx.waitUntil(task);
    }
    await Promise.all(tasks);
  },
} satisfies ExportedHandler<Env>;

async function handleThread(url: string, env: WorkerEnv): Promise<void> {
  try {
    const reviewCount = await fetchReviewCount(url);
    const key = KV_KEY_PREFIX + encodeURIComponent(url);
    const record = {
      url,
      reviewCount,
      fetchedAt: new Date().toISOString(),
    } satisfies ThreadRecord;
    await env.STEAM_DISCUSSION_COUNTS.put(key, JSON.stringify(record));
    console.log(`Stored review count for ${url}: ${reviewCount}`);
  } catch (error) {
    console.error(`Failed to process ${url}:`, error);
  }
}

async function fetchReviewCount(url: string): Promise<number> {
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
  const count = extractReviewCount(body);

  if (count === null) {
    throw new Error('Unable to locate review count in thread HTML.');
  }

  return count;
}

function extractReviewCount(html: string): number | null {
  const patterns = [
    /<span[^>]*class="commentthread_count_label"[^>]*>\s*([\d,.]+)\s*<\/span>/i,
    /"comment_count"\s*:\s*(\d+)/i,
    /"num_comments"\s*:\s*(\d+)/i,
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

interface ThreadRecord {
  url: string;
  reviewCount: number;
  fetchedAt: string;
}

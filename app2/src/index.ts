export default {
	async fetch(request, env, ctx): Promise<Response> {
		return new Response('Hello World!');
	},

	async scheduled(_event, env, ctx): Promise<void> {
		const appId = "1806330";
		const url = "https://steamcommunity.com/app/1806330/discussions/0/599658915298443000/";
		//const url = 'https://steamcommunity.com/comment/ForumTopic/render/103582791475223532/599658915298443000/?start=0';
		const res = await fetch(url, {
			headers: {
				'Cookie': `wants_mature_content_apps=${appId};`,
			}
		});
		//const resText = await res.text();
		//console.log({ resText });

		let scriptText = '';
		await new HTMLRewriter()
			.on('script[type="text/javascript"]', {
				text(element) {
					if (element.text.includes('InitializeCommentThread')) {
						scriptText = element.text;
						//console.log(element.text);
					}
				},
			}).transform(res).text();

		const jsonString = scriptText.split(',').slice(2, -2).join(',');
		//console.log({ jsonString });
		const data = JSON.parse(jsonString);
		console.log({ data });

		await Promise.all(Object.entries(data.comments_raw).map(([comId, comData]) => {
			return notifyDiscord({
				username: comData.author,
				content: comData.text,
			});
		}));
	},

} satisfies ExportedHandler<Env>;

interface DiscordWebhookPayload {
	content?: string;
	username?: string;
	embeds?: unknown[];
}

async function notifyDiscord(payload: DiscordWebhookPayload): Promise<void> {
	const webhookUrl = "https://discord.com/api/webhooks/1422598739092181174/SbxvvB5uuDzPBeC4LoaXy23ddOSr1Us7dnkd1OrlmXbzhDqsiIS_z31K_tjYdsGZbeIe";

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

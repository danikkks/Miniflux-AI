import { CronJob } from "cron";
import { OpenAI } from "openai";
import { readdir, readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_PROCESSING_INTERVAL_CRON = "*/1 * * * *";

type IMinifluxPage<T> = {
	total: number;
	entries: T[];
};

type IMinifluxCategory = {
	id: string;
	title: string;
	user_id: number;
	hide_globally: boolean;
};

type IMinifluxFeed = {
	id: string;
	category: IMinifluxCategory;
};

type IMinifluxEntry = {
	id: string;
	title: string;
	content: string;
	feed: IMinifluxFeed;
};

const initSync = async () => {
	const openAiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

	const entriesWithDecision = [];

	const getCustomPrompts = await loadCustomPrompts();

	const markIrrelevantArticlesAsReadJob = new CronJob(
		process.env.PROCESSING_INTERVAL_CRON ||
			DEFAULT_PROCESSING_INTERVAL_CRON,
		async () => {
			// get categories
			const categories = await fetch(
				`${process.env.MINIFLUX_URL}/v1/categories`,
				{
					headers: new Headers({
						"X-Auth-Token": process.env.MINIFLUX_AUTH_TOKEN,
					}),
				},
			).then((i) => i.json() as Promise<IMinifluxCategory[]>);

			if (process.env.LOGGING_LEVEL === "debug")
				console.debug(
					`categories: ${JSON.stringify(categories, null, 2)}`,
				);

			const categoriesWithPrompts = categories.filter(
				(i) =>
					!!getCustomPrompts().find((e) =>
						i.title.toLowerCase().includes(e.category),
					),
			);

			if (process.env.LOGGING_LEVEL === "debug")
				console.debug(
					`polyticsCategories: ${JSON.stringify(categoriesWithPrompts, null, 2)}`,
				);

			// get feeds
			const feeds = await Promise.all(
				categoriesWithPrompts.map((i) =>
					fetch(
						`${process.env.MINIFLUX_URL}/v1/categories/${i.id}/feeds`,
						{
							headers: new Headers({
								"X-Auth-Token": process.env.MINIFLUX_AUTH_TOKEN,
							}),
						},
					),
				),
			)
				.then((i) =>
					Promise.all(
						i.map((e) => e.json() as Promise<IMinifluxFeed[]>),
					),
				)
				.then((i) => i.flatMap((e) => e));

			if (process.env.LOGGING_LEVEL === "debug")
				console.debug(`feeds: ${JSON.stringify(feeds, null, 2)}`);

			// get unread entries
			const unreadEntries = await Promise.all(
				feeds.map((i) =>
					fetch(
						`${process.env.MINIFLUX_URL}/v1/feeds/${i.id}/entries?status=unread&order=published_at&direction=asc&limit=100`,
						{
							headers: new Headers({
								"X-Auth-Token": process.env.MINIFLUX_AUTH_TOKEN,
							}),
						},
					),
				),
			)
				.then((i) =>
					Promise.all(
						i.map(
							(e) =>
								e.json() as Promise<
									IMinifluxPage<IMinifluxEntry>
								>,
						),
					),
				)
				.then((i) => i.flatMap((e) => e.entries));

			if (process.env.LOGGING_LEVEL === "debug")
				console.debug(
					`unreadEntries: ${JSON.stringify(unreadEntries, null, 2)}`,
				);

			const unreadEntriesToVerify = unreadEntries
				.filter((i) => !entriesWithDecision.includes(i.id))
				.slice(0, parseInt(process.env.PROCESSING_BATCH_SIZE));

			if (process.env.LOGGING_LEVEL === "debug")
				console.debug(
					`unreadEntriesToVerify: ${JSON.stringify(unreadEntriesToVerify, null, 2)}`,
				);

			// get ai decisions
			const aiDecisions = await Promise.all(
				unreadEntriesToVerify.map((i) =>
					openAiClient.responses.create({
						model: "gpt-5-nano",
						instructions: getCustomPrompts().find((e) =>
							i.feed.category.title
								.toLowerCase()
								.includes(e.category),
						).content,
						input: `# ${i.title}\n${i.content}`,
					}),
				),
			).then((i) =>
				Promise.all(
					i.map((e, index) => ({
						decision: e.output_text,
						entryId: unreadEntriesToVerify[index].id,
					})),
				),
			);

			if (process.env.LOGGING_LEVEL === "debug")
				console.debug(
					`aiDecisions: ${JSON.stringify(aiDecisions, null, 2)}`,
				);

			const irrelevantEntryIds = aiDecisions
				.filter((i) => i.decision.toLowerCase().includes("no"))
				.map((i) => i.entryId);

			entriesWithDecision.push(...aiDecisions.map((i) => i.entryId));

			// mark irrelevant entries as read
			if (process.env.LOGGING_LEVEL === "debug") {
				console.debug(
					`Attempting to skip the following entries:\n${unreadEntries
						.filter((i) => irrelevantEntryIds.includes(i.id))
						.map((i) => `- ${i.title}`)
						.join("\n")}`,
				);
			}

			await fetch(`${process.env.MINIFLUX_URL}/v1/entries`, {
				method: "PUT",
				headers: new Headers({
					"X-Auth-Token": process.env.MINIFLUX_AUTH_TOKEN,
				}),
				body: JSON.stringify(
					{
						status: "read",
						entry_ids: irrelevantEntryIds,
					},
					null,
					2,
				),
			});

			if (process.env.LOGGING_LEVEL === "debug") {
				console.debug(
					`Successfully skipped the following entries:\n${unreadEntries
						.filter((i) => irrelevantEntryIds.includes(i.id))
						.map((i) => `- ${i.title}`)
						.join("\n")}`,
				);
			}
		},
	);

	markIrrelevantArticlesAsReadJob.start();
};

initSync();

/*
 * Helpers
 */

async function loadCustomPrompts() {
	const files = await readdir(__dirname);
	const customPromptFiles = files.filter(
		(i) => i.startsWith("custom-prompt-") && i.endsWith(".md"),
	);

	const customPromptContent = await Promise.all(
		customPromptFiles.map((i) =>
			readFile(resolve(__dirname, i), { encoding: "utf8" }),
		),
	).then((i) =>
		i.flatMap((e, index) => ({
			category: customPromptFiles[index]
				.replace(/^custom\-prompt\-/, "")
				.replace(/\.md$/, ""),
			content: e,
		})),
	);

	if (process.env.LOGGING_LEVEL === "debug")
		console.debug(
			`customPromptContent: ${JSON.stringify(customPromptContent, null, 2)}`,
		);

	return () => customPromptContent;
}

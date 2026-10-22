import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { stripHtml } from "string-strip-html";
import type { IFeedPublisher, IGroup } from "./core/entities.js";

const EXCERPT_LENGTH = 300;

const escape = (s: string): string =>
    s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const describe = (group: IGroup): string =>
    `${group.summary ? `<p>${escape(group.summary.description)}</p>` : ""}<ul>${group.entries
        .map((e) => `<li><a href="${escape(e.url)}">${escape(e.title)}</a><br/>${escape(stripHtml(e.content).result.slice(0, EXCERPT_LENGTH))}</li>`)
        .join("")}</ul>`;

const toItem = (group: IGroup): string => `<item>
<title>${escape(group.summary?.title ?? group.entries[0].title)}</title>
<link>${escape(group.entries[0].url)}</link>
<guid isPermaLink="false">group-${group.id}</guid>
<pubDate>${group.updatedAt.toUTCString()}</pubDate>
<description><![CDATA[${describe(group)}]]></description>
</item>`;

const buildFeed = (groups: IGroup[], title: string, link: string): string => {
    const lastBuild = groups[0] ? `\n<lastBuildDate>${groups[0].updatedAt.toUTCString()}</lastBuildDate>` : "";
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>${escape(title)}</title>
<link>${escape(link)}</link>
<description>${escape(title)}</description>${lastBuild}
${groups.map(toItem).join("\n")}
</channel>
</rss>
`;
};


export type B2Config = {
    endpoint: string;
    region: string;
    bucket: string;
    keyId: string;
    applicationKey: string;
    objectKey: string;
    feedTitle: string;
    feedLink: string;
};

export const makeB2FeedPublisher = (config: B2Config): IFeedPublisher => {
    const client = new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        credentials: { accessKeyId: config.keyId, secretAccessKey: config.applicationKey },
        forcePathStyle: true,
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
    });
    let lastPublished = "";

    return {
        isPublishedAt: (feedUrl) => {
            if (!URL.canParse(feedUrl)) return false;
            const { hostname, pathname } = new URL(feedUrl);
            const inBucket = pathname.includes(`/${config.bucket}/`) || hostname.startsWith(`${config.bucket.toLowerCase()}.`);
            return inBucket && pathname.endsWith(`/${config.objectKey}`);
        },

        publish: async (groups) => {
            const xml = buildFeed(groups, config.feedTitle, config.feedLink);
            if (xml === lastPublished) {
                return false;
            }
            await client.send(new PutObjectCommand({
                Bucket: config.bucket,
                Key: config.objectKey,
                Body: xml,
                ContentType: "application/rss+xml; charset=utf-8",
                CacheControl: "max-age=300",
            }));
            lastPublished = xml;
            return true;
        },
    };
};

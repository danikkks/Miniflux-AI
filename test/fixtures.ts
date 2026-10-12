export const PROMPT = {
    category: 'tech',
    filename: 'custom-prompt-tech.md',
    content: 'Is this about technology? Answer yes or no.',
};

export const CATEGORY = { id: 1, title: 'Technology News', user_id: 1, hide_globally: false };
export const FEED = { id: 10, category: CATEGORY };
export const ENTRY = { id: 100, title: 'New GPU released', url: 'http://example.com/gpu', content: 'A new GPU.', feed: FEED };
export const ENTRY_2 = { id: 101, title: 'Another GPU released', url: 'http://example.com/gpu2', content: 'Another GPU.', feed: FEED };
export const SUB_CATEGORY = { id: 2, title: 'Technology News / Blog', user_id: 1, hide_globally: false };
export const SUB_FEED = { id: 11, category: SUB_CATEGORY };
export const ENTRY_3 = { id: 102, title: 'Blog GPU review', url: 'http://example.com/gpu3', content: 'A GPU review.', feed: SUB_FEED };

export const GROUP_CATEGORY = { id: 3, title: 'World News', user_id: 1, hide_globally: false };
export const GROUP_FEED = { id: 12, category: GROUP_CATEGORY };
export const GROUP_ENTRY_A = { id: 200, title: 'Earthquake hits coast', url: 'http://example.com/quake-a', content: 'A strong earthquake.', feed: GROUP_FEED };
export const GROUP_ENTRY_B = { id: 201, title: 'Coastal quake: what we know', url: 'http://example.com/quake-b', content: 'Details on the quake.', feed: GROUP_FEED };
export const GROUP_SUB_CATEGORY = { id: 4, title: 'World News / Wire', user_id: 1, hide_globally: false };
export const GROUP_SUB_FEED = { id: 13, category: GROUP_SUB_CATEGORY };
export const GROUP_ENTRY_C = { id: 202, title: 'Quake rattles coast', url: 'http://example.com/quake-c', content: 'Wire report.', feed: GROUP_SUB_FEED };
export const GROUP_DIGEST = { id: 203, title: 'Weekly roundup', url: 'http://example.com/digest', content: 'Many stories.', feed: GROUP_FEED };

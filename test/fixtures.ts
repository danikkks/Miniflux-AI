export const PROMPT = {
    category: 'tech',
    filename: 'custom-prompt-tech.md',
    content: 'Is this about technology? Answer yes or no.',
};

export const CATEGORY = { id: 1, title: 'Technology News', user_id: 1, hide_globally: false };
export const FEED = { id: 10, category: CATEGORY };
export const ENTRY = { id: 100, title: 'New GPU released', content: 'A new GPU.', feed: FEED };

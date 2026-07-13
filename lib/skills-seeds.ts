// Builtin site skills: verified fetch-first shortcuts and constraints for major sites.
// Seeded once per version; agents and users can extend them like any skill.
// Every entry only contains verified knowledge (tested URL patterns, public APIs,
// or constraints observed in real sessions) — wrong priors are worse than none.
import { database, type SkillCategory } from './db.ts';
import { listSkills, saveSkill } from './skills.ts';

export const BUILTIN_SKILLS_VERSION = 7;
export const builtinSkillsVersionKey = 'builtinSkillsVersion';

type SeedSkill = {
  name: string;
  /** Localized display name for the sidepanel; the stored name stays English (logical key). */
  nameZh: string;
  hosts: string[];
  description: string;
  /** Localized display description for the sidepanel; the stored description feeds the model. */
  descriptionZh: string;
  category: SkillCategory;
  content: string;
};

export const builtinSkillSeeds: SeedSkill[] = [
  // ── Ticketing ──────────────────────────────────────────────────────────────
  {
    name: 'Tixbay ticket resale API',
    nameZh: 'Tixbay 票务转售 API',
    hosts: ['tixbay.com'],
    description: 'Query events and resale ticket prices via the tixbay JSON API instead of scraping the SPA',
    descriptionZh: '用 tixbay 公开 JSON API 直接查询演出和转售票价，跳过页面抓取',
    category: 'ticketing',
    content: [
      'tixbay.com renders dynamically: DOM snapshots and querySelectorAll come back nearly empty. Skip DOM exploration — the public JSON API needs no auth.',
      '',
      'Copy these URLs verbatim and only replace the <…> placeholders — do not rebuild or reorder the query string:',
      '',
      '1. Search: https://www.tixbay.com/api/v1/activity/search?keyword=<q>&page=1&pageSize=10&sortType=1&dateType=1&filterCategoryId=1&startTime=&endTime=&language=en-US&cityCode=852&platform=web&terminal=web&clientType=web&app=tixbay&channel=web&system=web&filterCityId=-1&timestamp=1&sign=1&deviceId=1&region=hk&version=1.0.0 — data[] has activity id, name, venue',
      '2. Sessions: https://www.tixbay.com/api/v6/activities/getAllEvents?activityId=<activityId>&language=en-US&cityCode=852&platform=web&terminal=web&clientType=web&app=tixbay&channel=web&system=web&filterCityId=-1&timestamp=1&sign=1&deviceId=1&region=hk&version=1.0.0 — data[] has one activityEventId per date',
      '3. Tickets: https://www.tixbay.com/api/v1/ticketGroup?activityEventId=<eventId>&buyCount=1&isContinuousSeat=false&sortType=1&ticketCategoryIds=&ticketAreaIds=&language=en-US&cityCode=852&platform=web&terminal=web&clientType=web&app=tixbay&channel=web&system=web&filterCityId=-1&timestamp=1&sign=1&deviceId=1&region=hk&version=1.0.0 — data[] has ticketCategorySpecification (face-value tier), salePrice (seller resale price), sellingAmount',
      '',
      'Flow: search → getAllEvents → one ticketGroup call per event, all via getDocument source:"url" (parallel is fine). Prices are seller-set resale; cityCode=852 returns HKD.',
      'Never navigate.open an API URL — it replaces the user-visible page with raw XML/JSON; always fetch APIs with getDocument source:"url".',
      'If the direct fetch fails (REMOTE_FETCH_FAILED), retry once; if it still fails, open https://www.tixbay.com/ in the browser and use the site search UI instead.',
      'After reporting prices, navigate.open https://www.tixbay.com/home/artist?keyword=<q> in the browser so the user can continue (view seats, buy) on the visible page.',
      'Pitfall: fetching https://www.tixbay.com/home directly returns NO_READABLE_CONTENT; use the API or read the opened page with browserRepl readVisibleText.',
    ].join('\n'),
  },
  {
    name: 'Damai ticketing site',
    nameZh: '大麦网',
    hosts: ['damai.cn'],
    description: 'Search URLs and SPA pitfalls for Chinese event tickets on Damai',
    descriptionZh: '大麦网搜索入口与动态页面注意事项',
    category: 'ticketing',
    content: [
      '- Search: https://search.damai.cn/search.htm?keyword=<q> (server-rendered enough for getDocument)',
      '- Detail pages (detail.damai.cn/item.htm?id=...) are dynamic SPAs: prefer browserRepl readVisibleText over getDocument currentPage.',
      'Pitfalls: buying requires login + real-name verification — stop and hand over to the user before any purchase step. Hot shows sell via lottery/queue; price tiers show as 票档.',
    ].join('\n'),
  },
  {
    name: 'Ticketmaster search',
    nameZh: 'Ticketmaster',
    hosts: ['ticketmaster.com'],
    description: 'Search URL patterns for Ticketmaster events',
    descriptionZh: 'Ticketmaster 演出搜索入口与购票限制',
    category: 'ticketing',
    content: [
      '- Search: https://www.ticketmaster.com/search?q=<query> — server-rendered event list readable with getDocument.',
      '- Artist/event pages list dates with links to /event/<id> pages; prices need the interactive seat map (browser tool).',
      'Pitfall: strong bot protection on ticket purchase pages; read-only research is fine, purchasing needs the real user.',
    ].join('\n'),
  },
  {
    name: 'StubHub resale',
    nameZh: 'StubHub 转售',
    hosts: ['stubhub.com'],
    description: 'StubHub resale ticket research: URL patterns and anti-bot notes',
    descriptionZh: 'StubHub 转售票研究：入口与反爬注意事项',
    category: 'ticketing',
    content: [
      '- Search: https://www.stubhub.com/secure/search?q=<query>',
      '- Event pages (/event/<id>) render listings dynamically: use browserRepl readVisibleText, not getDocument source:"url" (direct fetch gets challenge pages).',
      'Pitfall: aggressive anti-bot; if content stays empty, navigate in the browser and read the live page instead of fetching.',
    ].join('\n'),
  },
  // ── Shopping ───────────────────────────────────────────────────────────────
  {
    name: 'Amazon product search',
    nameZh: '亚马逊',
    hosts: ['amazon.com'],
    description: 'Amazon search and product URL patterns',
    descriptionZh: '亚马逊搜索与商品页 URL 模式',
    category: 'shopping',
    content: [
      '- Search: https://www.amazon.com/s?k=<query> (add &i=<department> to scope, &page=2 to paginate)',
      '- Product: https://www.amazon.com/dp/<ASIN> — title, price, rating are server-rendered and readable with getDocument.',
      'Pitfalls: prices/availability vary by delivery address; heavy fetching triggers CAPTCHA — prefer reading the opened page over many direct fetches.',
    ].join('\n'),
  },
  {
    name: 'Taobao search',
    nameZh: '淘宝 / 天猫',
    hosts: ['taobao.com', 'tmall.com'],
    description: 'Taobao/Tmall search URLs and login requirements',
    descriptionZh: '淘宝/天猫搜索入口与登录要求',
    category: 'shopping',
    content: [
      '- Search: https://s.taobao.com/search?q=<query> — usually redirects to login for anonymous visitors.',
      '- Item pages: https://item.taobao.com/item.htm?id=<id> (or detail.tmall.com) — dynamic, read with browserRepl readVisibleText.',
      'Pitfall: most content requires the user to be logged in; if a login wall appears, tell the user instead of trying to bypass it.',
    ].join('\n'),
  },
  {
    name: 'JD search',
    nameZh: '京东',
    hosts: ['jd.com'],
    description: 'JD.com search URL patterns and login notes',
    descriptionZh: '京东搜索入口与登录注意事项',
    category: 'shopping',
    content: [
      '- Search: https://search.jd.com/Search?keyword=<query>&enc=utf-8 — may redirect to passport.jd.com for anonymous sessions; if so, read the opened page after the user logs in.',
      '- Item pages: https://item.jd.com/<sku>.html — title is server-rendered; price loads dynamically, use browserRepl readVisibleText.',
    ].join('\n'),
  },
  {
    name: 'eBay search',
    nameZh: 'eBay',
    hosts: ['ebay.com'],
    description: 'eBay search and listing URL patterns',
    descriptionZh: 'eBay 搜索与商品页 URL 模式',
    category: 'shopping',
    content: [
      '- Search: https://www.ebay.com/sch/i.html?_nkw=<query> (add &_sop=15 for price+shipping lowest, &LH_Sold=1&LH_Complete=1 for sold listings)',
      '- Listing: https://www.ebay.com/itm/<id> — server-rendered, readable with getDocument.',
      'Pitfall: direct fetch may return 403 challenges; navigate in the browser when that happens.',
    ].join('\n'),
  },
  // ── Social ─────────────────────────────────────────────────────────────────
  {
    name: 'X (Twitter) browsing',
    nameZh: 'X（推特）',
    hosts: ['x.com', 'twitter.com'],
    description: 'X/Twitter navigation patterns and login constraints',
    descriptionZh: 'X/推特浏览入口与登录限制',
    category: 'social',
    content: [
      '- Search: https://x.com/search?q=<query>&f=live (f=live for latest) — requires login for most content.',
      '- Profile: https://x.com/<handle>; single post: https://x.com/<handle>/status/<id>.',
      'Pitfalls: no public API; heavy SPA with virtualized lists — use browserRepl readVisibleText and scroll incrementally. Anonymous visitors hit a login wall quickly; if so, tell the user.',
    ].join('\n'),
  },
  {
    name: 'Xiaohongshu browsing',
    nameZh: '小红书',
    hosts: ['xiaohongshu.com'],
    description: 'Xiaohongshu navigation and anti-scraping constraints',
    descriptionZh: '小红书浏览入口与反爬限制',
    category: 'social',
    content: [
      '- Search: https://www.xiaohongshu.com/search_result?keyword=<query> — requires login for most results.',
      '- Note pages are dynamic; read with browserRepl readVisibleText on the live page.',
      'Pitfalls: strong anti-scraping (direct fetch returns empty shells); never try to bypass login or captcha — surface the wall to the user.',
    ].join('\n'),
  },
  {
    name: 'Weibo browsing',
    nameZh: '微博',
    hosts: ['weibo.com', 'weibo.cn'],
    description: 'Weibo search entry points and login constraints',
    descriptionZh: '微博搜索入口与登录限制',
    category: 'social',
    content: [
      '- Search: https://s.weibo.com/weibo?q=<query> (hot list: https://s.weibo.com/top/summary needs login)',
      '- Mobile pages (m.weibo.cn) are lighter and often easier to read than desktop.',
      'Pitfalls: most timelines and comments require login; content behind login walls should be surfaced to the user, not bypassed.',
    ].join('\n'),
  },
  {
    name: 'Zhihu browsing',
    nameZh: '知乎',
    hosts: ['zhihu.com'],
    description: 'Zhihu search entry points and login-wall constraints',
    descriptionZh: '知乎搜索入口与登录墙限制',
    category: 'social',
    content: [
      '- Search: https://www.zhihu.com/search?type=content&q=<query>',
      '- Question pages (/question/<id>) show top answers server-rendered; expanding more answers requires login.',
      'Pitfalls: direct fetch often returns a verification page; read the opened page instead. A login modal appears after brief anonymous browsing — dismissing it once usually allows continued reading.',
    ].join('\n'),
  },
  {
    name: 'Instagram browsing',
    nameZh: 'Instagram',
    hosts: ['instagram.com'],
    description: 'Instagram navigation and login constraints',
    descriptionZh: 'Instagram 浏览入口与登录限制',
    category: 'social',
    content: [
      '- Profile: https://www.instagram.com/<handle>/; post: https://www.instagram.com/p/<code>/.',
      'Pitfalls: nearly all content requires login; anonymous fetch returns login shells. Work on the live logged-in page with browserRepl readVisibleText, and surface login walls to the user.',
    ].join('\n'),
  },
  // ── Video ──────────────────────────────────────────────────────────────────
  {
    name: 'YouTube video data',
    nameZh: 'YouTube',
    hosts: ['youtube.com', 'youtu.be'],
    description: 'YouTube search URLs and the public oEmbed API for video metadata',
    descriptionZh: 'YouTube 搜索入口与公开 oEmbed 元数据 API',
    category: 'video',
    content: [
      '- Search: https://www.youtube.com/results?search_query=<query> — dynamic page, read with browserRepl readVisibleText.',
      '- Video metadata without opening the page: https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=<id>&format=json — title, author_name, thumbnail (no auth).',
      '- Channel: https://www.youtube.com/@<handle>/videos',
      'Pitfall: transcripts and comments need the live page; watch pages are heavy SPAs.',
    ].join('\n'),
  },
  {
    name: 'Bilibili video data',
    nameZh: '哔哩哔哩',
    hosts: ['bilibili.com'],
    description: 'Bilibili search URLs and the public view API for video metadata',
    descriptionZh: 'B站搜索入口与公开视频信息 API',
    category: 'video',
    content: [
      '- Search page: https://search.bilibili.com/all?keyword=<query> — dynamic, read with browserRepl readVisibleText.',
      '- Video metadata API (no auth): https://api.bilibili.com/x/web-interface/view?bvid=<BV id> — data.title, data.owner.name, data.stat (views/likes), data.pages.',
      'Pitfall: most other bilibili APIs need WBI signatures or login; do not guess them, fall back to the live page.',
    ].join('\n'),
  },
  {
    name: 'Douyin browsing',
    nameZh: '抖音',
    hosts: ['douyin.com'],
    description: 'Douyin search entry points and anti-bot constraints',
    descriptionZh: '抖音搜索入口与反爬限制',
    category: 'video',
    content: [
      '- Hot page: https://www.douyin.com/hot',
      '- Search: https://www.douyin.com/search/<url-encoded query>',
      '- Dynamic lists and video pages are heavy SPAs: inspect the live page with browser snapshot first; use browserRepl readVisibleText only when substantial non-interactive text is missing.',
      '- Never infer what an unlabeled card number means (views, likes, or heat). Report it verbatim unless live-page semantics identify the metric.',
      'Pitfalls: strong anti-bot — anonymous visits frequently hit slider captchas or login prompts; never try to solve captchas, surface them to the user. Direct fetch returns empty shells.',
    ].join('\n'),
  },
  {
    name: 'TikTok video data',
    nameZh: 'TikTok',
    hosts: ['tiktok.com'],
    description: 'TikTok search URLs and the public oEmbed API for video metadata',
    descriptionZh: 'TikTok 搜索入口与公开 oEmbed 元数据 API',
    category: 'video',
    content: [
      '- Search: https://www.tiktok.com/search?q=<query> — dynamic, often requires login for full results.',
      '- Video metadata without opening the page: https://www.tiktok.com/oembed?url=https://www.tiktok.com/@<handle>/video/<id> — title, author_name, thumbnail (no auth).',
      'Pitfall: region walls and login prompts are common; read the live page and surface walls to the user.',
    ].join('\n'),
  },
  // ── Travel ─────────────────────────────────────────────────────────────────
  {
    name: 'Booking.com search',
    nameZh: 'Booking.com',
    hosts: ['booking.com'],
    description: 'Booking.com hotel search URL patterns',
    descriptionZh: 'Booking.com 酒店搜索 URL 模式',
    category: 'travel',
    content: [
      '- Search: https://www.booking.com/searchresults.html?ss=<destination>&checkin=<YYYY-MM-DD>&checkout=<YYYY-MM-DD>&group_adults=2',
      '- Results render dynamically; read with browserRepl readVisibleText. Prices vary by currency/session.',
      'Pitfall: prices are per-stay by default and change with dates/currency; always state the dates and currency you observed.',
    ].join('\n'),
  },
  {
    name: 'Airbnb search',
    nameZh: '爱彼迎',
    hosts: ['airbnb.com'],
    description: 'Airbnb stay search URL patterns',
    descriptionZh: '爱彼迎民宿搜索 URL 模式',
    category: 'travel',
    content: [
      '- Search: https://www.airbnb.com/s/<location>/homes?checkin=<YYYY-MM-DD>&checkout=<YYYY-MM-DD>&adults=2',
      '- Listings (/rooms/<id>) render dynamically; read with browserRepl readVisibleText.',
      'Pitfall: totals differ from nightly rates (cleaning/service fees); quote the all-in total when comparing.',
    ].join('\n'),
  },
  // ── Social/news communities (reference-style APIs) ────────────────────────
  {
    name: 'Hacker News data API',
    nameZh: 'Hacker News',
    hosts: ['news.ycombinator.com'],
    description: 'Read HN stories and comments via the official JSON API instead of scraping pages',
    descriptionZh: '用官方 JSON API 读取 HN 帖子与评论，无需抓页面',
    category: 'social',
    content: [
      'Fetch-first: use getDocument source:"url" or sandbox fetch on the official Firebase API. No auth needed.',
      '',
      '- Top story ids: https://hacker-news.firebaseio.com/v0/topstories.json (also newstories, beststories, askstories, showstories)',
      '- Item (story/comment): https://hacker-news.firebaseio.com/v0/item/<id>.json — fields: title, url, score, by, time, kids (comment ids)',
      '- User: https://hacker-news.firebaseio.com/v0/user/<username>.json',
      '',
      'Flow: fetch topstories ids → fetch first N items in parallel via sandbox. Only open news.ycombinator.com pages when the user wants the live page.',
    ].join('\n'),
  },
  {
    name: 'Reddit JSON endpoints',
    nameZh: 'Reddit',
    hosts: ['reddit.com'],
    description: 'Read subreddits, posts, and comments by appending .json to any Reddit URL',
    descriptionZh: '在任意 Reddit URL 后加 .json 直接读取版块、帖子与评论',
    category: 'social',
    content: [
      'Fetch-first: append .json to almost any reddit.com URL and read it with getDocument source:"url" or sandbox fetch.',
      '',
      '- Subreddit listing: https://www.reddit.com/r/<sub>/hot.json?limit=25 (also new, top?t=week)',
      '- Post with comments: https://www.reddit.com/r/<sub>/comments/<id>.json',
      '- Search: https://www.reddit.com/search.json?q=<query>&sort=relevance',
      '',
      'Data shape: data.children[].data holds title, score, permalink, selftext, num_comments.',
      'Pitfall: heavy use can hit 429 rate limits; slow down or open the page in the browser instead.',
    ].join('\n'),
  },
  // ── Developer ──────────────────────────────────────────────────────────────
  {
    name: 'GitHub REST API',
    nameZh: 'GitHub',
    hosts: ['github.com'],
    description: 'Read repos, issues, PRs, files, and releases via api.github.com instead of scraping',
    descriptionZh: '用 api.github.com 读取仓库、issue、PR、文件与发布',
    category: 'developer',
    content: [
      'Fetch-first: public data is available unauthenticated at api.github.com (60 req/h per IP).',
      '',
      '- Repo: https://api.github.com/repos/<owner>/<repo> — stars, forks, topics, default_branch',
      '- Issues/PRs: https://api.github.com/repos/<owner>/<repo>/issues?state=open (PRs have a pull_request key)',
      '- File content: https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>',
      '- Releases: https://api.github.com/repos/<owner>/<repo>/releases/latest',
      '- Search: https://api.github.com/search/repositories?q=<query>&sort=stars',
      '',
      'Pitfall: 403 with "rate limit exceeded" means the IP quota ran out; fall back to reading github.com pages in the browser.',
    ].join('\n'),
  },
  {
    name: 'Stack Exchange API',
    nameZh: 'Stack Overflow',
    hosts: ['stackoverflow.com', 'stackexchange.com'],
    description: 'Search questions and answers via the Stack Exchange JSON API instead of scraping',
    descriptionZh: '用 Stack Exchange JSON API 搜索问题与答案',
    category: 'developer',
    content: [
      'Fetch-first, no key needed for light use (shared IP quota ~300/day; responses are gzip JSON).',
      '',
      '- Search: https://api.stackexchange.com/2.3/search/advanced?q=<query>&site=stackoverflow&sort=relevance&filter=withbody',
      '- Question with answers: https://api.stackexchange.com/2.3/questions/<id>?site=stackoverflow&filter=withbody then /questions/<id>/answers?filter=withbody',
      '',
      'Data shape: items[] with title, link, score, is_answered, body (HTML). Pitfall: quota exhaustion returns error_id 502; fall back to opening the page.',
    ].join('\n'),
  },
  {
    name: 'npm registry API',
    nameZh: 'npm',
    hosts: ['npmjs.com'],
    description: 'Read package metadata and search npm via registry.npmjs.org instead of scraping',
    descriptionZh: '用 registry.npmjs.org 读取与搜索 npm 包信息',
    category: 'developer',
    content: [
      'Fetch-first, no auth.',
      '',
      '- Package (all versions): https://registry.npmjs.org/<name> — dist-tags.latest, versions, repository, maintainers',
      '- Latest only (small): https://registry.npmjs.org/<name>/latest',
      '- Search: https://registry.npmjs.org/-/v1/search?text=<query>&size=10 — objects[].package with name, description, links',
      '- Weekly downloads: https://api.npmjs.org/downloads/point/last-week/<name>',
      '',
      'Scoped packages URL-encode the slash: @scope%2Fname.',
    ].join('\n'),
  },
  {
    name: 'PyPI JSON API',
    nameZh: 'PyPI',
    hosts: ['pypi.org'],
    description: 'Read Python package metadata via the PyPI JSON API instead of scraping',
    descriptionZh: '用 PyPI JSON API 读取 Python 包信息',
    category: 'developer',
    content: [
      'Fetch-first, no auth.',
      '',
      '- Package: https://pypi.org/pypi/<name>/json — info.version, info.summary, info.project_urls, releases',
      '- Specific version: https://pypi.org/pypi/<name>/<version>/json',
      '',
      'There is no official search endpoint; for search, fetch https://pypi.org/search/?q=<query> as a page or use getDocument source:"url".',
    ].join('\n'),
  },
  // ── Reference ──────────────────────────────────────────────────────────────
  {
    name: 'Wikipedia REST API',
    nameZh: '维基百科',
    hosts: ['wikipedia.org'],
    description: 'Read article summaries and full text via the Wikimedia REST API',
    descriptionZh: '用 Wikimedia REST API 读取词条摘要与全文',
    category: 'reference',
    content: [
      'Fetch-first, works for any language edition (replace en with the language code).',
      '',
      '- Summary: https://en.wikipedia.org/api/rest_v1/page/summary/<Title> — extract, description, thumbnail',
      '- Full HTML: https://en.wikipedia.org/api/rest_v1/page/html/<Title> (parse with getDocument source:"url")',
      '- Search: https://en.wikipedia.org/w/rest.php/v1/search/page?q=<query>&limit=5',
      '',
      'Titles use underscores for spaces and are case-sensitive after the first letter.',
    ].join('\n'),
  },
  {
    name: 'arXiv export API',
    nameZh: 'arXiv',
    hosts: ['arxiv.org'],
    description: 'Search papers and read abstracts via the arXiv Atom API instead of scraping',
    descriptionZh: '用 arXiv Atom API 搜索论文与读取摘要',
    category: 'reference',
    content: [
      'Fetch-first, no auth. Responses are Atom XML; parse titles/summaries from <entry> blocks.',
      '',
      '- Search: http://export.arxiv.org/api/query?search_query=all:<query>&start=0&max_results=10&sortBy=submittedDate&sortOrder=descending',
      '- By id: http://export.arxiv.org/api/query?id_list=2401.00001',
      '- PDF: https://arxiv.org/pdf/<id> (read directly with getDocument source:"url")',
      '',
      'Pitfall: fielded queries use prefixes like ti: (title), au: (author), cat: (category), combined with +AND+.',
    ].join('\n'),
  },
];

/** Sidepanel display localization for builtin skills, keyed by stored (English) name. */
export function builtinSkillDisplay(name: string): { nameZh: string; descriptionZh: string } | undefined {
  const seed = builtinSkillSeeds.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  return seed ? { nameZh: seed.nameZh, descriptionZh: seed.descriptionZh } : undefined;
}

export async function seedBuiltinSkills() {
  const setting = await database.settings.get(builtinSkillsVersionKey);
  if (setting?.value === BUILTIN_SKILLS_VERSION) return false;
  const existingByName = new Map((await listSkills()).map((skill) => [skill.name.toLowerCase(), skill]));
  for (const seed of builtinSkillSeeds) {
    // Never overwrite user- or agent-authored skills; only refresh builtin rows.
    const existing = existingByName.get(seed.name.toLowerCase());
    if (existing && existing.source !== 'builtin') continue;
    try {
      await saveSkill({ name: seed.name, hosts: seed.hosts, description: seed.description, content: seed.content, category: seed.category, source: 'builtin' });
    } catch (error) {
      console.warn(`Taber builtin skill "${seed.name}" skipped:`, error);
    }
  }
  await database.settings.put({ key: builtinSkillsVersionKey, value: BUILTIN_SKILLS_VERSION });
  return true;
}

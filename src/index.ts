import { GoogleGenerativeAI } from "@google/generative-ai";

// 興味のあるトピックをここに記述（プロンプトに組み込まれます）
const MY_INTERESTS = "Bun, TypeScript, Cloudflare, Rust, AI, LLM";

export default {
  // Cron（定期実行）で呼ばれるメイン処理
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // 1. 各ソースからデータを取得
    const [redditNews, hnNews] = await Promise.all([
      fetchReddit(),
      fetchHackerNews()
    ]);

    const rawNewsList = [...redditNews, ...hnNews].join("\n");

    // 2. Geminiでフィルタリング・日本語化
    const prompt = `
      あなたはIT専門のニュースキュレーターです。
      提供されたニュースリストから、私の興味（${MY_INTERESTS}）に関連するものだけを厳選してください。
      
      【ルール】
      ・興味に合うものがなければ、返信の1行目に「なし」とだけ書いてください。
      ・あれば1件につき1行で「[ソース] タイトルの日本語訳 (URL)」の形式で出力してください。
      ・関連性が低いニュースは容赦なく捨ててください。
      ・最大5件まで。

      【ニュースリスト】
      ${rawNewsList}
    `;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();

    // 3. Discordへ通知（「なし」でない場合のみ）
    if (!responseText.includes("なし") && responseText.length > 0) {
      await fetch(env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `📅 **本日の厳選ITニュース**\n\n${responseText}`
        })
      });
    }
  },
};

// --- ヘルパー関数群 ---

// RedditからJSONで取得
async function fetchReddit() {
  try {
    const resp = await fetch("https://www.reddit.com/r/technology/top.json?limit=10", {
      headers: { "User-Agent": "MyNewsBot/1.0" }
    });
    const json: any = await resp.json();
    return json.data.children.map((c: any) => `[Reddit] ${c.data.title} - ${c.data.url}`);
  } catch (e) {
    console.error("Reddit取得失敗", e);
    return [];
  }
}

// Hacker Newsから最新のTop 10件を取得
async function fetchHackerNews() {
  try {
    const idsResp = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
    const ids = (await idsResp.json() as number[]).slice(0, 10);
    
    return await Promise.all(ids.map(async (id) => {
      const itemResp = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      const item: any = await itemResp.json();
      return `[HN] ${item.title} - ${item.url || `https://news.ycombinator.com/item?id=${id}`}`;
    }));
  } catch (e) {
    console.error("HN取得失敗", e);
    return [];
  }
}

// 環境変数の型定義
interface Env {
  GEMINI_API_KEY: string;
  DISCORD_WEBHOOK_URL: string;
}
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { prompt } = await req.json();
    if (!prompt) return NextResponse.json({ error: "No prompt provided" }, { status: 400 });

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

    if (!GEMINI_API_KEY) {
      return NextResponse.json({ response: "Simulated Action (No API Key). You asked to: " + prompt, action: {} }, { status: 200 });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout for Gemini

    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          systemInstruction: {
            parts: [{ text: "You are an AI Trading Copilot for Aura Perps DEX. Your job is to extract trading intent from the user's prompt. Supported assets are BTC, ETH, AMZN, TSLA, AMD, NFLX, PLTR. The AI agent manages Stop Loss and Take Profit autonomously off-chain. Output strictly JSON with 'action' (must be exactly 'open_position'), 'asset' (e.g. 'BTC-PERP', 'AMZN-PERP'), 'isLong' (boolean), 'collateral' (number in USD, the actual amount the user provides, not the leveraged size), 'leverage' (number), 'takeProfit' (string/number, optional), 'stopLoss' (string/number, optional), and a 'message' describing what you will do (including acknowledging the TP/SL config if requested). Be concise. Output ONLY valid JSON, no markdown formatting." }]
          },
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
          }
        })
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const err = await response.text();
        console.error("Gemini API Error:", err);
        return NextResponse.json({ error: "Failed to reach AI API" }, { status: 500 });
      }

      const data = await response.json();
      const resultContent = data.candidates[0].content.parts[0].text;

      let p;
      try {
        p = JSON.parse(resultContent);
      } catch (parseErr) {
        console.error("Failed to parse Gemini output:", resultContent);
        return NextResponse.json({ error: "Invalid AI response format" }, { status: 500 });
      }

      console.log(`🤖 [NLP Agent] Prompt received: "${prompt}"`);
      if (p.action === 'open_position') {
        console.log(`📈 [NLP Agent] Trade Intent Detected: ${p.isLong ? 'LONG' : 'SHORT'} ${p.asset} | Collateral: $${p.collateral} | Leverage: ${p.leverage}x`);
      } else {
        console.log(`💬 [NLP Agent] General Intent: ${p.message}`);
      }

      return NextResponse.json(p);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.error("Gemini API Timeout (15s exceeded)");
        return NextResponse.json({ error: "AI response timed out. Please try again." }, { status: 504 });
      }
      throw err;
    }

  } catch (error) {
    console.error("API Route Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
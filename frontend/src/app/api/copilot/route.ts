import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey || apiKey.includes('placeholder') || apiKey.trim() === '') {
      return NextResponse.json({
        reply: '⚠️ DeepSeek API key missing. Please add your real DEEPSEEK_API_KEY to frontend/.env.local and restart npm run dev.'
      });
    }

    const { messages, currentAuditFindings } = await req.json();

    const systemPrompt = `You are an expert 3D CAD/BIM Quality Control AI Assistant.
Here is the active inspection clash and dimensional data:
${JSON.stringify(currentAuditFindings, null, 2)}

Answer user questions accurately and concisely. Focus specifically on clearances, pipe diameters, collision coordinates, and practical engineering fixes.`;

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...(messages || []).map((m: any) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content || m.text || '',
      })),
    ];

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: apiMessages,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('DeepSeek Error:', errText);
      return NextResponse.json({
        reply: `API Error (${response.status}): ${errText.slice(0, 120)}`
      });
    }

    const data = await response.json().catch(() => null);

    if (!data) {
      return NextResponse.json({
        reply:
          'DeepSeek returned a response that was not valid JSON. The request may have been truncated — try again, and check the server logs for the raw payload.',
      });
    }

    const reply: string | undefined = data.choices?.[0]?.message?.content;

    if (typeof reply !== 'string' || reply.trim() === '') {
      const finishReason = data.choices?.[0]?.finish_reason;
      const reason = finishReason
        ? ` The model stopped with finish_reason "${finishReason}".`
        : ' The response carried no choices[0].message.content.';

      return NextResponse.json({
        reply: `DeepSeek returned an empty reply.${reason}`,
      });
    }

    return NextResponse.json({ reply });
  } catch (error: any) {
    console.error('Copilot Route Error:', error);
    return NextResponse.json({
      reply: `Server Exception: ${error?.message || 'Failed to process request'}`
    });
  }
}
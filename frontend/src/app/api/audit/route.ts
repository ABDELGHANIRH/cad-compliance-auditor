import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 300; // Allows up to 5 minutes for heavy geometry conversion

const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN ?? 'http://127.0.0.1:8000';

export async function POST(request: NextRequest) {
  const contentType = request.headers.get('content-type');
  if (!contentType || !contentType.includes('multipart/form-data')) {
    return NextResponse.json(
      { detail: 'Expected multipart/form-data payload.' },
      { status: 400 },
    );
  }

  try {
    const upstream = await fetch(`${BACKEND_ORIGIN}/api/audit`, {
      method: 'POST',
      headers: {
        'content-type': contentType,
      },
      body: request.body,
      // @ts-expect-error duplex is required by Node.js fetch when streaming request bodies
      duplex: 'half',
    });

    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        'content-type':
          upstream.headers.get('content-type') ?? 'application/json',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        detail:
          'Could not reach the audit service at ' +
          BACKEND_ORIGIN +
          '. Ensure the backend is running.',
      },
      { status: 502 },
    );
  }
}
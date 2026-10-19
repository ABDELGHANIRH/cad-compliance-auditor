import { NextRequest, NextResponse } from 'next/server';

/**
 * Server-side proxy for the FastAPI /api/audit endpoint.
 *
 * The browser posts the multipart form here, same-origin; this route forwards it
 * to the backend and streams the response straight back. Two things fall out of
 * that: the browser never issues a cross-origin request (so the audit works
 * whether the page is on localhost:3000 or 127.0.0.1:3000), and uploads stay
 * server-to-server, so large STEP files are not constrained by CORS preflight.
 */

export const runtime = 'nodejs';
// STEP files can be large; give the geometry import room to finish.
export const maxDuration = 300;

const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN ?? 'http://127.0.0.1:8000';

export async function POST(request: NextRequest) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { detail: 'Could not read the uploaded form data.' },
      { status: 400 },
    );
  }

  try {
    const upstream = await fetch(`${BACKEND_ORIGIN}/api/audit`, {
      method: 'POST',
      body: form,
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
    // Almost always means uvicorn is not running.
    return NextResponse.json(
      {
        detail:
          'Could not reach the audit service at ' +
          BACKEND_ORIGIN +
          '. Start the backend with: uvicorn main:app --reload --port 8000',
      },
      { status: 502 },
    );
  }
}

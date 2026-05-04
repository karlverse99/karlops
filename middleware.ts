import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/** Apex marketing domain: serve static landing at `/` instead of the app shell (avoids auth redirect loop). */
const MARKETING_HOSTS = new Set(['karlops.com', 'www.karlops.com']);

export function middleware(request: NextRequest) {
  const host = request.headers.get('host')?.split(':')[0]?.toLowerCase() ?? '';
  if (MARKETING_HOSTS.has(host) && request.nextUrl.pathname === '/') {
    return NextResponse.rewrite(new URL('/karlops-landing.html', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/'],
};

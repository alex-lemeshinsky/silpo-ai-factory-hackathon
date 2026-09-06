import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { getServerEnv, type ServerEnv } from "@/lib/env";
import {
  createSilpoOAuthService,
  type CallbackInput,
  type SilpoOAuthService,
} from "@/features/silpo/oauth/service";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

const MSG_MALFORMED = "Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.";

const ALLOWED_QUERY_PARAMS = new Set([
  "state",
  "code",
  "error",
  "iss",
  "error_description",
  "error_uri",
  "session_state",
]);

export function createStartHandler(
  getService: () => SilpoOAuthService = () => createSilpoOAuthService(),
  getEnv: () => ServerEnv = () => getServerEnv(),
) {
  return async function GET(request: NextRequest): Promise<NextResponse> {
    const correlationId = randomUUID();
    let env: ServerEnv;
    try {
      env = getEnv();
    } catch {
      return NextResponse.json(
        {
          code: "unexpected",
          message: "Не вдалося завершити вхід. Спробуйте ще раз.",
          correlationId,
          retryAfterMs: null,
        },
        { status: 500, headers: responseHeaders },
      );
    }

    if (env.DATA_MODE === "demo") {
      return NextResponse.json(
        {
          code: "unexpected",
          message: "Not found",
          correlationId,
          retryAfterMs: null,
        },
        { status: 404, headers: responseHeaders },
      );
    }

    // Reject any query parameters (prevent open redirects, caller-supplied IDs, etc.)
    if (request.nextUrl.searchParams.size > 0) {
      return NextResponse.json(
        {
          code: "unauthorized",
          message: MSG_MALFORMED,
          correlationId,
          retryAfterMs: null,
        },
        { status: 400, headers: responseHeaders },
      );
    }

    let result;
    try {
      const handle = request.cookies.get("silpo_session")?.value ?? null;
      const service = getService();
      result = await service.start(handle, correlationId);
    } catch {
      return NextResponse.json(
        {
          code: "unexpected",
          message: "Не вдалося завершити вхід. Спробуйте ще раз.",
          correlationId,
          retryAfterMs: null,
        },
        { status: 500, headers: responseHeaders },
      );
    }

    if (result.ok) {
      const location = result.value.location;
      const redirectUrl =
        location.startsWith("http://") || location.startsWith("https://")
          ? location
          : new URL(location, env.PUBLIC_BASE_URL).toString();

      const response = NextResponse.redirect(redirectUrl, 303);
      response.headers.set("Cache-Control", responseHeaders["Cache-Control"]);
      response.headers.set("Referrer-Policy", responseHeaders["Referrer-Policy"]);

      if (result.value.cookie) {
        response.cookies.set("silpo_session", result.value.cookie.value, {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: env.NODE_ENV === "production",
          maxAge: result.value.cookie.maxAge,
          expires: result.value.cookie.expiresAt,
        });
      }

      return response;
    }

    const response = NextResponse.json(result.error.error, {
      status: result.error.status,
      headers: responseHeaders,
    });

    if (result.error.clearCookie) {
      response.cookies.set("silpo_session", "", {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: env.NODE_ENV === "production",
        maxAge: 0,
        expires: new Date(0),
      });
    }

    return response;
  };
}

export function createCallbackHandler(
  getService: () => SilpoOAuthService = () => createSilpoOAuthService(),
  getEnv: () => ServerEnv = () => getServerEnv(),
) {
  return async function GET(request: NextRequest): Promise<NextResponse> {
    const correlationId = randomUUID();
    let env: ServerEnv;
    try {
      env = getEnv();
    } catch {
      return NextResponse.json(
        {
          code: "unexpected",
          message: "Не вдалося завершити вхід. Спробуйте ще раз.",
          correlationId,
          retryAfterMs: null,
        },
        { status: 500, headers: responseHeaders },
      );
    }

    if (env.DATA_MODE === "demo") {
      return NextResponse.json(
        {
          code: "unexpected",
          message: "Not found",
          correlationId,
          retryAfterMs: null,
        },
        { status: 404, headers: responseHeaders },
      );
    }

    const rawQuery = request.nextUrl.search;
    if (rawQuery.length > 8192) {
      return NextResponse.json(
        {
          code: "unauthorized",
          message: MSG_MALFORMED,
          correlationId,
          retryAfterMs: null,
        },
        { status: 400, headers: responseHeaders },
      );
    }

    const searchParams = request.nextUrl.searchParams;

    // Check for unknown params or duplicates using getAll
    const keys = Array.from(searchParams.keys());
    for (const key of keys) {
      if (!ALLOWED_QUERY_PARAMS.has(key)) {
        return NextResponse.json(
          {
            code: "unauthorized",
            message: MSG_MALFORMED,
            correlationId,
            retryAfterMs: null,
          },
          { status: 400, headers: responseHeaders },
        );
      }
      if (searchParams.getAll(key).length > 1) {
        return NextResponse.json(
          {
            code: "unauthorized",
            message: MSG_MALFORMED,
            correlationId,
            retryAfterMs: null,
          },
          { status: 400, headers: responseHeaders },
        );
      }
    }

    const state = searchParams.get("state");
    if (!state || state.length > 256) {
      return NextResponse.json(
        {
          code: "unauthorized",
          message: MSG_MALFORMED,
          correlationId,
          retryAfterMs: null,
        },
        { status: 400, headers: responseHeaders },
      );
    }

    const code = searchParams.get("code");
    const error = searchParams.get("error");

    if ((code && error) || (!code && !error)) {
      return NextResponse.json(
        {
          code: "unauthorized",
          message: MSG_MALFORMED,
          correlationId,
          retryAfterMs: null,
        },
        { status: 400, headers: responseHeaders },
      );
    }

    if (code && code.length > 4096) {
      return NextResponse.json(
        {
          code: "unauthorized",
          message: MSG_MALFORMED,
          correlationId,
          retryAfterMs: null,
        },
        { status: 400, headers: responseHeaders },
      );
    }

    const handle = request.cookies.get("silpo_session")?.value ?? null;
    const issuer = searchParams.get("iss") ?? undefined;

    const input: CallbackInput = {
      handle,
      state,
      code: code ?? undefined,
      issuer,
      denied: Boolean(error),
    };

    let result;
    try {
      const service = getService();
      result = await service.callback(input, correlationId);
    } catch {
      return NextResponse.json(
        {
          code: "unexpected",
          message: "Не вдалося завершити вхід. Спробуйте ще раз.",
          correlationId,
          retryAfterMs: null,
        },
        { status: 500, headers: responseHeaders },
      );
    }

    if (result.ok) {
      const pathWithSlash = result.value.location.startsWith("/")
        ? result.value.location
        : `/${result.value.location}`;
      const sanitizedPath = pathWithSlash.replace(/^\/+/, "/");
      const redirectUrl = new URL(sanitizedPath, env.PUBLIC_BASE_URL).toString();

      const response = NextResponse.redirect(redirectUrl, 303);
      response.headers.set("Cache-Control", responseHeaders["Cache-Control"]);
      response.headers.set("Referrer-Policy", responseHeaders["Referrer-Policy"]);

      if (result.value.cookie) {
        response.cookies.set("silpo_session", result.value.cookie.value, {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: env.NODE_ENV === "production",
          maxAge: result.value.cookie.maxAge,
          expires: result.value.cookie.expiresAt,
        });
      }

      return response;
    }

    const response = NextResponse.json(result.error.error, {
      status: result.error.status,
      headers: responseHeaders,
    });

    if (result.error.clearCookie) {
      response.cookies.set("silpo_session", "", {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: env.NODE_ENV === "production",
        maxAge: 0,
        expires: new Date(0),
      });
    }

    return response;
  };
}

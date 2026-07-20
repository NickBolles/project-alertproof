import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { ServerRouter } from "react-router";
import type { EntryContext } from "react-router";
import { renderToPipeableStream } from "react-dom/server";
import { isbot } from "isbot";
import { startWebhookWorker } from "./lib/ingest/worker.server";

const ABORT_DELAY = 5_000;

startWebhookWorker();

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  const callbackName =
    isbot(request.headers.get("user-agent") ?? "") || routerContext.isSpaMode
      ? "onAllReady"
      : "onShellReady";

  return new Promise<Response>((resolve, reject) => {
    let shellRendered = false;
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        [callbackName]() {
          shellRendered = true;
          const body = new PassThrough();
          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(createReadableStreamFromReadable(body), {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          if (shellRendered) console.error(error);
        },
      },
    );

    setTimeout(abort, ABORT_DELAY);
  });
}

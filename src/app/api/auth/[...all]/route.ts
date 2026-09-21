import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/modules/auth";

async function handle(request: Request) {
  const handlers = toNextJsHandler(await getAuth());
  return request.method === "GET" ? handlers.GET(request) : handlers.POST(request);
}

export { handle as GET, handle as POST };

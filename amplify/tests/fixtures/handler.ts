// Bundling fixture only; production entries remain in src/functions.
export async function handler() {
  return { statusCode: 200, body: 'ok', batchItemFailures: [] };
}

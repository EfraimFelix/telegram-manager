import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderRuntimeConfig } from '../../scripts/write-runtime-config.mjs';

const outputs = {
  custom: { runtime: {
    region: 'us-east-1',
    dbResourceArn: 'arn:aws:rds:us-east-1:111111111111:cluster:test',
    dbSecretArn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:database-test',
    dbName: 'telegram_manager',
    appSecretArn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:app-test',
    queueUrl: 'https://sqs.us-east-1.amazonaws.com/111111111111/test',
    webhookBaseUrl: 'https://test.lambda-url.us-east-1.on.aws/',
    computeRoleArn: 'arn:aws:iam::111111111111:role/test',
    password: 'NEVER_COPY_THIS_SECRET',
  } },
};

test('runtime config uses an explicit allowlist and includes the SSR webhook origin', () => {
  const config = renderRuntimeConfig(outputs, 'https://app.example.com');
  assert.equal(config.split('\n').filter(line => /^[A-Z_]+=/.test(line)).length, 7);
  assert.ok(!config.includes('QUEUE_URL='));
  assert.ok(config.includes('WEBHOOK_BASE_URL=https://test.lambda-url.us-east-1.on.aws/'));
  assert.ok(config.includes('BETTER_AUTH_URL=https://app.example.com'));
  assert.ok(!config.includes('NEVER_COPY_THIS_SECRET'));
  assert.ok(!config.includes('computeRoleArn'));
  assert.ok(!config.includes('NEXT_PUBLIC_'));
});

test('missing fields, mismatched regions and dotenv injection fail before writing', () => {
  assert.throws(() => renderRuntimeConfig({}, 'https://app.example.com'), /Missing/);
  for (const value of ['', 'name\nPASSWORD=oops', '$PASSWORD', 'name"', 'name\\']) {
    assert.throws(() => renderRuntimeConfig({ custom: { runtime: { ...outputs.custom.runtime, dbName: value } } }, 'https://app.example.com'));
  }
  assert.throws(() => renderRuntimeConfig({ custom: { runtime: { ...outputs.custom.runtime, region: 'us-west-2' } } }, 'https://app.example.com'), /DB_RESOURCE_ARN/);
  for (const url of [undefined, 'http://app.example.com', 'https://user:password@app.example.com', 'https://app.example.com/path']) {
    assert.throws(() => renderRuntimeConfig(outputs, url));
  }
});

test('CLI writes only the generated non-secret file and leaves it unchanged on failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-config-test-'));
  try {
    const input = join(directory, 'outputs.json');
    const output = join(directory, '.env.production');
    const script = fileURLToPath(new URL('../../scripts/write-runtime-config.mjs', import.meta.url));
    writeFileSync(input, JSON.stringify(outputs));
    const env = { ...process.env, BETTER_AUTH_URL: 'https://app.example.com', APP_SECRET: 'NEVER_COPY_ENV' };
    const success = spawnSync(process.execPath, [script, input, output], { env, encoding: 'utf8' });
    assert.equal(success.status, 0, success.stderr);
    const config = readFileSync(output, 'utf8');
    assert.equal(config, renderRuntimeConfig(outputs, env.BETTER_AUTH_URL));
    const failure = spawnSync(process.execPath, [script, input, output], { env: { ...env, BETTER_AUTH_URL: '' }, encoding: 'utf8' });
    assert.notEqual(failure.status, 0);
    assert.equal(readFileSync(output, 'utf8'), config);
    assert.ok(!config.includes('NEVER_COPY_ENV'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

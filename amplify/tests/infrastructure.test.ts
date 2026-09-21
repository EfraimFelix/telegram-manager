import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ModerationInfrastructure } from '../infrastructure.js';

const outdir = mkdtempSync(join(tmpdir(), 'telegram-infra-test-'));
after(() => rmSync(outdir, { recursive: true, force: true }));
const app = new App({ outdir, context: { 'aws:cdk:availability-zones:account=111111111111:region=us-east-1': ['us-east-1a', 'us-east-1b'] } });
const stack = new Stack(app, 'Test', { env: { account: '111111111111', region: 'us-east-1' } });
const fixture = fileURLToPath(new URL('./fixtures/handler.ts', import.meta.url));
const infrastructure = new ModerationInfrastructure(stack, 'Moderation', {
  webhookEntry: fixture, workerEntry: fixture,
});
const template = Template.fromStack(stack);

test('Aurora uses one private writer, Data API, and bounded scale-to-zero', () => {
  template.resourceCountIs('AWS::RDS::DBInstance', 1);
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    Engine: 'aurora-postgresql',
    EnableHttpEndpoint: true,
    DatabaseName: 'telegram_manager',
    StorageEncrypted: true,
    DeletionProtection: true,
    ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 2, SecondsUntilAutoPause: 300 },
  });
  template.hasResourceProperties('AWS::RDS::DBInstance', {
    DBInstanceClass: 'db.serverless', PubliclyAccessible: false,
  });
  template.hasResource('AWS::RDS::DBCluster', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  template.resourceCountIs('AWS::EC2::Subnet', 2);
  for (const type of ['AWS::EC2::NatGateway', 'AWS::EC2::InternetGateway', 'AWS::EC2::VPCEndpoint', 'AWS::EC2::SecurityGroupIngress']) {
    template.resourceCountIs(type, 0);
  }
  for (const group of Object.values(template.findResources('AWS::EC2::SecurityGroup'))) {
    assert.equal(group.Properties.SecurityGroupIngress, undefined);
  }
});

test('only two application Lambdas, with public URL restricted to URL invocation', () => {
  template.resourceCountIs('AWS::Lambda::Function', 2);
  template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
  template.resourceCountIs('AWS::Lambda::Permission', 2);
  template.hasResourceProperties('AWS::Lambda::Permission', {
    Principal: '*', Action: 'lambda:InvokeFunctionUrl', FunctionUrlAuthType: 'NONE',
  });
  template.hasResourceProperties('AWS::Lambda::Permission', {
    Principal: '*', Action: 'lambda:InvokeFunction', InvokedViaFunctionUrl: true,
  });
  for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) {
    assert.equal(fn.Properties.VpcConfig, undefined);
    assert.equal(fn.Properties.Runtime, 'nodejs22.x');
    assert.equal(fn.Properties.Environment.Variables.WEBHOOK_BASE_URL, undefined);
  }
  const functions = Object.values(template.findResources('AWS::Lambda::Function'));
  const webhook = functions.find(fn => fn.Properties.Environment.Variables.QUEUE_URL)!;
  const worker = functions.find(fn => fn.Properties.Environment.Variables.DB_RESOURCE_ARN)!;
  assert.deepEqual(Object.keys(webhook.Properties.Environment.Variables).sort(), ['APP_SECRET_ARN', 'QUEUE_URL']);
  assert.deepEqual(Object.keys(worker.Properties.Environment.Variables).sort(), ['APP_SECRET_ARN', 'DB_NAME', 'DB_RESOURCE_ARN', 'DB_SECRET_ARN']);
});

test('standard SQS retries are bounded, isolated per message, and end in a retained DLQ', () => {
  template.resourceCountIs('AWS::SQS::Queue', 2);
  const queues = Object.values(template.findResources('AWS::SQS::Queue'));
  const source = queues.find(q => q.Properties.RedrivePolicy)!;
  const worker = Object.values(template.findResources('AWS::Lambda::Function'))
    .find(fn => fn.Properties.ReservedConcurrentExecutions === 2)!;
  assert.equal(source.Properties.FifoQueue, undefined);
  assert.equal(source.Properties.RedrivePolicy.maxReceiveCount, 5);
  assert.ok(source.Properties.VisibilityTimeout >= worker.Properties.Timeout * 6);
  assert.equal(queues.find(q => !q.Properties.RedrivePolicy)!.Properties.MessageRetentionPeriod, 14 * 86400);
  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    BatchSize: 1, FunctionResponseTypes: ['ReportBatchItemFailures'], ScalingConfig: { MaximumConcurrency: 2 },
  });
});

test('SSR compute role can use Data API and both secrets without wildcard resources', () => {
  const roles = template.findResources('AWS::IAM::Role');
  const roleIds = Object.entries(roles)
    .filter(([, role]) => role.Properties.Description === 'Attach to the Amplify Hosting branch SSR compute role setting.')
    .map(([id]) => id);
  assert.equal(roleIds.length, 1);
  template.hasResourceProperties('AWS::IAM::Role', {
    Description: 'Attach to the Amplify Hosting branch SSR compute role setting.',
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({ Principal: { Service: 'amplify.amazonaws.com' } })]),
    }),
  });
  const [roleId] = roleIds;
  const policies = Object.values(template.findResources('AWS::IAM::Policy'))
    .filter(policy => policy.Properties.Roles.some((role: { Ref?: string }) => role.Ref === roleId));
  const statements = policies.flatMap(policy => policy.Properties.PolicyDocument.Statement) as Array<{ Action: string | string[]; Resource: unknown }>;
  const actions = statements.flatMap(statement => Array.isArray(statement.Action) ? statement.Action : [statement.Action]);
  for (const action of ['rds-data:ExecuteStatement', 'rds-data:BeginTransaction', 'rds-data:CommitTransaction', 'rds-data:RollbackTransaction', 'secretsmanager:GetSecretValue']) {
    assert.ok(actions.includes(action), `Missing ${action}`);
  }
  assert.equal(actions.includes('sqs:SendMessage'), false);
  const secretReads = statements.filter(statement => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes('secretsmanager:GetSecretValue'));
  assert.ok(secretReads.length >= 1);
  assert.ok(statements.every(statement => statement.Resource !== '*'));
});

test('secrets remain generated and retained, and outputs contain identifiers only', () => {
  template.resourceCountIs('AWS::SecretsManager::Secret', 2);
  template.hasResourceProperties('AWS::SecretsManager::Secret', {
    GenerateSecretString: {
      SecretStringTemplate: '{"typesafeApiKey":""}', GenerateStringKey: 'key',
      PasswordLength: 64, ExcludePunctuation: true, IncludeSpace: false,
    },
  });
  for (const secret of Object.values(template.findResources('AWS::SecretsManager::Secret'))) {
    assert.equal(secret.DeletionPolicy, 'Retain');
  }
  assert.deepEqual(Object.keys(infrastructure.runtime).sort(), [
    'appSecretArn', 'computeRoleArn', 'dbName', 'dbResourceArn', 'dbSecretArn', 'queueUrl', 'region', 'webhookBaseUrl',
  ]);
});

test('webhook errors, queue age, and DLQ alarms publish to an SNS topic', () => {
  template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
  template.resourceCountIs('AWS::SNS::Topic', 1);
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'ApproximateAgeOfOldestMessage', Threshold: 300,
  });
  for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
    assert.equal(alarm.Properties.AlarmActions.length, 1);
    assert.equal(alarm.Properties.TreatMissingData, 'notBreaching');
  }
});

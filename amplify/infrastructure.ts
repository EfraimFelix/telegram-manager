import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface InfrastructureProps {
  webhookEntry?: string;
  workerEntry?: string;
  databaseUrl?: string;
}

export class ModerationInfrastructure extends Construct {
  readonly runtime: Record<string, string>;

  constructor(scope: Construct, id: string, props: InfrastructureProps = {}) {
    super(scope, id);

    const databaseUrl = props.databaseUrl ?? process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required to configure the worker.');
    const databaseProtocol = new URL(databaseUrl).protocol;
    if (databaseProtocol !== 'postgres:' && databaseProtocol !== 'postgresql:') {
      throw new Error('DATABASE_URL must use the PostgreSQL protocol.');
    }
    const appSecret = new secretsmanager.Secret(this, 'ApplicationSecret', {
      description: 'Stable auth/encryption key and manually configured TypeSafe API key.',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ typesafeApiKey: '' }),
        generateStringKey: 'key',
        passwordLength: 64,
        excludePunctuation: true,
        includeSpace: false,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const workerTimeout = Duration.seconds(60);
    const deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const queue = new sqs.Queue(this, 'UpdatesQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.seconds(workerTimeout.toSeconds() * 6),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 5 },
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const createFunction = (name: string, entry: string, timeout: Duration, concurrency: number, environment: Record<string, string>) => {
      const logGroup = new logs.LogGroup(this, `${name}Logs`, {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      const fn = new NodejsFunction(this, name, {
        entry,
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout,
        reservedConcurrentExecutions: concurrency,
        environment,
        logGroup,
        // Bundle SDK dependencies to use the versions in the lockfile.
        bundling: { minify: true, sourceMap: true, externalModules: [] },
      });
      return fn;
    };
    const webhook = createFunction(
      'Webhook',
      props.webhookEntry ?? fileURLToPath(new URL('../src/functions/webhook.ts', import.meta.url)),
      Duration.seconds(15),
      10,
      { APP_SECRET_ARN: appSecret.secretArn, QUEUE_URL: queue.queueUrl },
    );
    const worker = createFunction(
      'Worker',
      props.workerEntry ?? fileURLToPath(new URL('../src/functions/worker.ts', import.meta.url)),
      workerTimeout,
      2,
      {
        APP_SECRET_ARN: appSecret.secretArn,
        DATABASE_URL: databaseUrl,
      },
    );
    appSecret.grantRead(webhook);
    appSecret.grantRead(worker);
    queue.grantSendMessages(webhook);
    worker.addEventSource(new SqsEventSource(queue, {
      batchSize: 1,
      reportBatchItemFailures: true,
      maxConcurrency: 2,
    }));
    // CDK 2.270 emits both permissions, including InvokedViaFunctionUrl=true.
    const webhookUrl = webhook.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    const computeRole = new iam.Role(this, 'SsrComputeRole', {
      assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
      description: 'Attach to the Amplify Hosting branch SSR compute role setting.',
    });
    appSecret.grantRead(computeRole);

    const alarmsTopic = new sns.Topic(this, 'AlarmsTopic');
    for (const [name, metric, threshold] of [
      ['DeadLetterMessages', deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5), statistic: 'Maximum',
      }), 1],
      ['WebhookErrors', webhook.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }), 1],
      ['QueueAge', queue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(5), statistic: 'Maximum' }), 300],
    ] as const) {
      const alarm = new cloudwatch.Alarm(this, name, {
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(new SnsAction(alarmsTopic));
    }
    new CfnOutput(this, 'AlarmsTopicArn', { value: alarmsTopic.topicArn });

    this.runtime = {
      appSecretArn: appSecret.secretArn,
      queueUrl: queue.queueUrl,
      webhookBaseUrl: webhookUrl.url,
      computeRoleArn: computeRole.roleArn,
    };
  }
}

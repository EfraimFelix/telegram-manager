import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface InfrastructureProps {
  webhookEntry?: string;
  workerEntry?: string;
}

export class ModerationInfrastructure extends Construct {
  readonly runtime: Record<string, string>;

  constructor(scope: Construct, id: string, props: InfrastructureProps = {}) {
    super(scope, id);

    const vpc = new ec2.Vpc(this, 'DatabaseVpc', {
      maxAzs: 2,
      natGateways: 0,
      createInternetGateway: false,
      // Avoid the CDK custom-resource Lambda; the database uses its own SG.
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [{ name: 'Database', subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
    });
    const databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      allowAllOutbound: false,
      description: 'No direct database connections; application access uses the RDS Data API.',
    });
    const databaseSecret = new rds.DatabaseSecret(this, 'DatabaseSecret', {
      username: 'clusteradmin',
    });
    databaseSecret.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const database = new rds.DatabaseCluster(this, 'Database', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_13,
      }),
      writer: rds.ClusterInstance.serverlessV2('Writer', { publiclyAccessible: false }),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 2,
      serverlessV2AutoPauseDuration: Duration.minutes(5),
      enableDataApi: true,
      credentials: rds.Credentials.fromSecret(databaseSecret),
      defaultDatabaseName: 'telegram_manager',
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [databaseSecurityGroup],
      storageEncrypted: true,
      storageType: rds.DBClusterStorageType.AURORA,
      backup: { retention: Duration.days(7) },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
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
        DB_RESOURCE_ARN: database.clusterArn,
        DB_SECRET_ARN: databaseSecret.secretArn,
        DB_NAME: 'telegram_manager',
      },
    );
    appSecret.grantRead(webhook);
    appSecret.grantRead(worker);
    database.grantDataApiAccess(worker);
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
    database.grantDataApiAccess(computeRole);
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
      region: Stack.of(this).region,
      dbResourceArn: database.clusterArn,
      dbSecretArn: databaseSecret.secretArn,
      dbName: 'telegram_manager',
      appSecretArn: appSecret.secretArn,
      queueUrl: queue.queueUrl,
      webhookBaseUrl: webhookUrl.url,
      computeRoleArn: computeRole.roleArn,
    };
  }
}

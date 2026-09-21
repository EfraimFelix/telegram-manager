import { defineBackend } from '@aws-amplify/backend';
import { ModerationInfrastructure } from './infrastructure.js';

const backend = defineBackend({});
const infrastructure = new ModerationInfrastructure(
  backend.createStack('Moderation'),
  'Moderation',
);

backend.addOutput({ custom: { runtime: infrastructure.runtime } });

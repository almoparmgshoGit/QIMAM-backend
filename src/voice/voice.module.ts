import { Module } from '@nestjs/common';
import { VoiceGateway } from './voice.gateway.js';
import { VoiceService } from './voice.service.js';

@Module({
  providers: [VoiceService, VoiceGateway],
  exports: [VoiceService],
})
export class VoiceModule {}

import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AiService } from './ai.service';

@Controller('ai')
export class AiController {
  constructor(private ai: AiService) {}

  @UseGuards(JwtAuthGuard)
  @Post('compose')
  compose(@Body('prompt') prompt: string) {
    return this.ai.composeWorkflow(prompt);
  }
}

import { Body, Controller, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RunService } from './run.service';

@Controller()
export class RunController {
  constructor(private runs: RunService) {}

  @UseGuards(JwtAuthGuard)
  @Post('workflows/:id/run')
  run(@Request() req, @Param('id') id: string, @Body('input') input: Record<string, any>) {
    return this.runs.run(req.user.id, id, input ?? {});
  }

  @Get('workflows/:id/runs')
  list(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.runs.list(id, Number(limit) || 20);
  }

  @Get('runs/:id')
  get(@Param('id') id: string) {
    return this.runs.get(id);
  }

  @Get('runs/:id/verify')
  verify(@Param('id') id: string) {
    return this.runs.verify(id);
  }
}

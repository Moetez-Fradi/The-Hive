import { Controller, Post, Body, UseGuards, Request, Get, Param, Delete } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrivateWorkflowInstanceService } from './private-workflow-instance.service';

@UseGuards(JwtAuthGuard)
@Controller('workflow-instances')
export class PrivateWorkflowInstanceController {
  constructor(private service: PrivateWorkflowInstanceService) {}

  @Post()
  async create(@Request() req, @Body('workflowId') workflowId: string, @Body('graphJson') graphJson: any) {
    return this.service.createInstance(req.user.id, workflowId, graphJson);
  }

  @Post(':id/run')
  async runInstance(@Request() req, @Param('id') id: string, @Body() inputBody: Record<string, any>) {
    return this.service.runInstance(req.user.id, id, inputBody);
  }

  @Get()
  async list(@Request() req) {
    return this.service.getUserInstances(req.user.id);
  }

  @Get(':id')
  async get(@Request() req, @Param('id') id: string) {
    return this.service.getInstance(id, req.user.id);
  }

  @Delete(':id')
  async delete(@Request() req, @Param('id') id: string) {
    return this.service.deleteInstance(id, req.user.id);
  }
}

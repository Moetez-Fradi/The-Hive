import { Controller, Post, Body, Query, UseGuards, Request, Param, Delete, HttpCode, Get } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WorkflowService } from './workflow.service';

@Controller('workflows')
export class WorkflowController {
  constructor(private workflowService: WorkflowService) {}
  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Request() req,
    @Body('graphJson') graphJson: any,
    @Body('fixedUsageFee') fixedUsageFee?: number,
    @Body('name') name?: string,
    @Body('description') description?: string,
  ) {
    // Step 1: create the workflow normally
    const workflow = await this.workflowService.createWorkflow(
      req.user.id,
      req.user.walletAccountId,
      graphJson,
      name,
      fixedUsageFee,
      description
    );

    // Step 2: automatically test it using same graphJson
    const testResult = await this.workflowService.testWorkflow(
      req.user.id,
      workflow.workflow.id,
      graphJson
    );

    return {
      success: true,
      workflow: workflow.workflow,
      test: testResult,
    };
  }
  @UseGuards(JwtAuthGuard)
  @Post(':id/test')
  async test(@Request() req, @Param('id') id: string, @Body('graphJson') graphJson: any) {
    return this.workflowService.testWorkflow(req.user.id, id, graphJson);
  }
  @UseGuards(JwtAuthGuard)
  @Post(':id/deploy')
  async deploy(@Request() req, @Param('id') id: string, @Body('graphJson') graphJson: any, @Body('tests') tests: Array<any>) {
    return this.workflowService.runDeployTests(req.user.id, id, graphJson, tests || []);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(204)
  async remove(@Request() req, @Param('id') id: string) {
    await this.workflowService.deleteWorkflow(id, req.user.id);
  }

  @Get('search')
  async search(@Query('q') query: string) {
    return this.workflowService.searchWorkflows(query, 10);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.workflowService.findById(id);
  }

  @Get()
  async list(@Query('page') page: string) {
    const pageNum = parseInt(page) || 1;
    return this.workflowService.listWorkflows(pageNum, 10);
  }

}

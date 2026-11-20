import { Module } from '@nestjs/common';
import { WorkflowService } from './workflow.service';
import { WorkflowController } from './workflow.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { HttpModule } from '@nestjs/axios';
import { NodeService } from '../node/node.service';

@Module({
  imports: [PrismaModule, HttpModule],
  providers: [WorkflowService, NodeService],
  controllers: [WorkflowController]
})
export class WorkflowModule {}

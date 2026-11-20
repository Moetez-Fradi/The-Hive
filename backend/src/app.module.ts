import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { UserModule } from './user/user.module';
import { AuthModule } from './auth/auth.module';
import { ToolModule } from './tool/tool.module';
import { ReviewModule } from './review/review.module';
import { PrivateToolInstanceModule } from './private-tool-instance/private-tool-instance.module';
import { WorkflowModule } from './workflow/workflow.module';
import { PrivateWorkflowInstanceModule } from './private-workflow-instance/private-workflow-instance.module';
import { NodeModule } from './node/node.module';
import { TaskModule } from './task/task.module';
import { ScheduleModule } from '@nestjs/schedule';
import { NodeMonitorModule } from './node-monitor/node-monitor.module';
import { HederaModule } from './hedera/hedera.module';
import { PaymentModule } from './payment/payment.module';
import { RunModule } from './run/run.module';
import { AiModule } from './ai/ai.module';

@Module({
  imports: [PrismaModule, UserModule, AuthModule, ToolModule, ReviewModule, PrivateToolInstanceModule, WorkflowModule, PrivateWorkflowInstanceModule, NodeModule, TaskModule, ScheduleModule.forRoot(), NodeMonitorModule, HederaModule, PaymentModule, RunModule, AiModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

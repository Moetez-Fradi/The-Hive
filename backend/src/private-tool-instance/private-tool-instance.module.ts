import { forwardRef, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrivateToolInstanceService } from './private-tool-instance.service';
import { PrivateToolInstanceController } from './private-tool-instance.controller';
import { ToolModule } from '../tool/tool.module';

@Module({
  imports: [HttpModule, forwardRef(() => ToolModule)],
  controllers: [PrivateToolInstanceController],
  providers: [PrivateToolInstanceService],
  exports: [PrivateToolInstanceService],
})
export class PrivateToolInstanceModule {}
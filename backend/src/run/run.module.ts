import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { RunController } from './run.controller';
import { RunService } from './run.service';

@Module({
  imports: [HttpModule],
  controllers: [RunController],
  providers: [RunService],
})
export class RunModule {}

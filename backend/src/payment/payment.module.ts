import { Module } from '@nestjs/common';
import { PaymentsService } from './payment.service';
import { PaymentsController } from './payment.controller';

@Module({
  providers: [PaymentsService],
  controllers: [PaymentsController]
})
export class PaymentModule {}

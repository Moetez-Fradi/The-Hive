import { Controller, Post, Body, Get, Param, BadRequestException, HttpCode } from '@nestjs/common';
import { PaymentsService } from './payment.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  async create(@Body() body: CreatePaymentDto) {
    const { instanceId, payer, receipt, memo } = body;
    if (!instanceId || !payer || !Array.isArray(receipt)) {
      throw new BadRequestException('instanceId, payer and receipt are required');
    }
    return this.paymentsService.createPayment(instanceId, payer, receipt, memo);
  }

  @Post('confirm')
  @HttpCode(200)
  async confirm(@Body() body: ConfirmPaymentDto) {
    const { instanceId, txId } = body;
    if (!instanceId || !txId) throw new BadRequestException('instanceId and txId required');
    return this.paymentsService.confirmPayment(instanceId, txId);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.paymentsService.getPaymentById(id);
  }
}

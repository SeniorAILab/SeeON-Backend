import { IsDateString, IsString, Length, Matches } from 'class-validator';

export class DashboardDeliveryReceiptRequestDto {
  @IsString()
  @Length(1, 128)
  dashboardClientId!: string;

  @IsString()
  @Length(1, 191)
  backendEventId!: string;

  @IsString()
  @Length(1, 191)
  alertId!: string;

  @Matches(/^\d+$/)
  alertSeq!: string;

  @IsDateString()
  observedAt!: string;
}

export class DashboardPresentationReceiptRequestDto extends DashboardDeliveryReceiptRequestDto {
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9:-]{0,63}$/)
  surface!: string;
}

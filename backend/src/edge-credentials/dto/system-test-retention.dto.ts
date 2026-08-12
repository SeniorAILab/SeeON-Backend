import { IsIn, IsNotEmpty, IsString, Matches } from 'class-validator';

export class PurgeSystemTestRetentionRequestDto {
  @IsIn([1])
  schemaVersion!: 1;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  facilityId!: string;
}

export interface PurgeSystemTestRetentionResponseDto {
  schemaVersion: 1;
  receiptId: string | null;
  jobId: string;
  facilityId: string;
  purgedEvents: number;
  purgedAlerts: number;
  purgedDashboardReceipts: number;
  purgedAlertNotes: number;
  purgedAt: Date | null;
  replayed: boolean;
}

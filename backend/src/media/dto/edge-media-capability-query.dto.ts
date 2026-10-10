import { IsString } from 'class-validator';

export class EdgeMediaCapabilityQueryDto {
  @IsString()
  camera_id!: string;
}

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

const EDGE_REF = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class EdgeTopologyCameraDto {
  @IsString()
  @Matches(EDGE_REF)
  edgeRef!: string;

  @IsString()
  @Length(1, 120)
  label!: string;
}

export class EdgeTopologyRoomDto {
  @IsString()
  @Matches(EDGE_REF)
  edgeRef!: string;

  @IsString()
  @Length(1, 120)
  name!: string;

  @IsIn(['ROOM'])
  type!: 'ROOM';

  @IsInt()
  @Min(1)
  capacity!: number;

  @IsOptional()
  @IsUUID()
  legacyCanonicalSpaceId?: string;

  @IsArray()
  @ArrayMaxSize(1)
  @ValidateNested({ each: true })
  @Type(() => EdgeTopologyCameraDto)
  cameras!: EdgeTopologyCameraDto[];
}

export class EdgeTopologyFloorDto {
  @IsString()
  @Matches(EDGE_REF)
  edgeRef!: string;

  @IsString()
  @Length(1, 120)
  name!: string;

  @IsInt()
  @Min(0)
  orderIndex!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EdgeTopologyRoomDto)
  rooms!: EdgeTopologyRoomDto[];
}

export class EdgeTopologySnapshotRequestDto {
  @IsIn([1])
  schemaVersion!: 1;

  @IsUUID()
  edgeInstallationId!: string;

  @IsInt()
  @Min(1)
  enrollmentGeneration!: number;

  @IsInt()
  @Min(1)
  clientRevision!: number;

  @IsInt()
  @Min(0)
  expectedServerRevision!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EdgeTopologyFloorDto)
  floors!: EdgeTopologyFloorDto[];
}

export class EdgeTopologyConfirmationRequestDto {
  @IsIn([1])
  schemaVersion!: 1;

  @IsUUID()
  confirmationId!: string;

  @IsString()
  @Matches(SHA256)
  digest!: string;

  @IsInt()
  @Min(0)
  expectedServerRevision!: number;
}

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
// Hub canonical ids are opaque (cuid, or hand-seeded like sp_201) — never assume UUID.
const CANONICAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class EdgeTopologyCameraRequestDto {
  @IsString()
  @Matches(EDGE_REF)
  edgeRef!: string;

  @IsString()
  @Length(1, 120)
  label!: string;
}

export class EdgeTopologyRoomRequestDto {
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
  @IsString()
  @Matches(CANONICAL_ID)
  legacyCanonicalSpaceId?: string;

  @IsArray()
  @ArrayMaxSize(1)
  @ValidateNested({ each: true })
  @Type(() => EdgeTopologyCameraRequestDto)
  cameras!: EdgeTopologyCameraRequestDto[];
}

export class EdgeTopologyFloorRequestDto {
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
  @Type(() => EdgeTopologyRoomRequestDto)
  rooms!: EdgeTopologyRoomRequestDto[];
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
  @Type(() => EdgeTopologyFloorRequestDto)
  floors!: EdgeTopologyFloorRequestDto[];
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

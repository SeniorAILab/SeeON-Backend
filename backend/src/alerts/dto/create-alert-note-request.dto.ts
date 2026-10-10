import { IsString, Matches } from 'class-validator';

export class CreateAlertNoteRequestDto {
  @IsString()
  @Matches(/\S/, { message: 'note is required' })
  note!: string;
}

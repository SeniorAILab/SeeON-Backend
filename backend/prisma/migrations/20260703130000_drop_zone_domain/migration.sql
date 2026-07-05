-- DESTRUCTIVE: drops zones table + ZoneType. 폐기(disposable) 정책, 배포 전 pg_dump --table=zones 백업 필수.

DROP TABLE "zones";
DROP TYPE "ZoneType";

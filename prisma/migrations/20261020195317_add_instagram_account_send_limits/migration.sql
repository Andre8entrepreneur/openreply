-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN     "dailyDmLimit" INTEGER,
ADD COLUMN     "hourlyDmLimit" INTEGER NOT NULL DEFAULT 750;

-- Codes made by the OTP provider are never seen by the server, so there is no hash to store.
ALTER TABLE "otp_challenges" ALTER COLUMN "code_hmac" DROP NOT NULL;

import type { Model } from 'mongoose';
import type { GoogleOAuthStateDocument } from '~/types/googleOAuthState';
import googleOAuthStateSchema from '~/schema/googleOAuthState';

export function createGoogleOAuthStateModel(
  mongoose: typeof import('mongoose'),
): Model<GoogleOAuthStateDocument> {
  return (
    mongoose.models.GoogleOAuthState ??
    mongoose.model<GoogleOAuthStateDocument>('GoogleOAuthState', googleOAuthStateSchema)
  );
}

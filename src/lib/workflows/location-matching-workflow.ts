import { buildLocationMatchingPromptVariables } from '../ai/location-matching-prompt';
import { locationMatchResponseSchema } from '../ai/response-schemas';
import { getGenerationChannel } from '../realtime';
import { sanitizeFailResponse } from '../workflow/sanitize-fail-response';
import { createScopedWorkflow } from '../workflow/scoped-workflow';
import type {
  LibraryLocationMatch,
  LocationMatchingWorkflowInput,
  LocationMatchingWorkflowOutput,
} from '../workflow/types';
import { durableLLMCall } from './llm-call-helper';

export const locationMatchingWorkflow = createScopedWorkflow<
  LocationMatchingWorkflowInput,
  LocationMatchingWorkflowOutput
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;
    const { analysisModelId, suggestedLocationIds } = input;
    const { sequenceId, userId, teamId } = input;

    const llmCallContext = {
      sequenceId,
      userId,
      teamId,
    };

    // Use pre-extracted bible from scene splitting, or fall back to LLM extraction
    const locationBible = input.locationBible;

    // Location matching (conditional)
    const { libraryLocationList, locationMatchingPromptVariables } =
      await context.run('get-library-locations', async () => {
        if (!suggestedLocationIds?.length || !input.teamId) {
          return {
            libraryLocationList: [],
            locationMatchingPromptVariables: {},
          };
        }
        const libraryLocationList =
          await scopedDb.locations.getByIds(suggestedLocationIds);
        return {
          libraryLocationList,
          locationMatchingPromptVariables: buildLocationMatchingPromptVariables(
            locationBible,
            libraryLocationList
          ),
        };
      });

    const { matches: locationMatches } =
      libraryLocationList.length > 0
        ? await durableLLMCall(
            context,
            {
              name: 'location-matching',
              phase: { number: 2, name: 'Matching locations…' },

              promptName: 'phase/location-matching-chat',
              promptVariables: locationMatchingPromptVariables,
              modelId: analysisModelId,
              responseSchema: locationMatchResponseSchema,
            },
            llmCallContext
          )
        : { matches: [] };

    const libraryLocationMatches: LibraryLocationMatch[] = await context.run(
      'build-location-matches',
      async () => {
        const usedLibraryIds = new Set<string>();
        const usedLocationIds = new Set<string>();
        const matches: LibraryLocationMatch[] = [];

        for (const match of locationMatches) {
          if (usedLibraryIds.has(match.libraryLocationId)) continue;
          if (usedLocationIds.has(match.locationId)) continue;
          if (match.confidence < 0.5) continue;

          const libraryLoc = libraryLocationList.find(
            (lib) => lib.id === match.libraryLocationId
          );
          if (!libraryLoc?.referenceImageUrl) continue;

          const location = locationBible.find(
            (loc) => loc.locationId === match.locationId
          );
          if (!location) continue;

          usedLibraryIds.add(match.libraryLocationId);
          usedLocationIds.add(match.locationId);
          matches.push({
            locationId: match.locationId,
            libraryLocationId: match.libraryLocationId,
            libraryLocationName: libraryLoc.name,
            referenceImageUrl: libraryLoc.referenceImageUrl,
            description: libraryLoc.description ?? undefined,
          });
        }

        if (matches.length > 0) {
          await getGenerationChannel(sequenceId).emit(
            'generation.location:matched',
            {
              matches: matches.map((m) => {
                const loc = locationBible.find(
                  (l) => l.locationId === m.locationId
                );
                return {
                  locationId: m.locationId,
                  locationName: loc?.name ?? m.locationId,
                  libraryLocationId: m.libraryLocationId,
                  libraryLocationName: m.libraryLocationName,
                  referenceImageUrl: m.referenceImageUrl,
                  description: m.description ?? undefined,
                };
              }),
            }
          );
        }

        return matches;
      }
    );

    return {
      locationBible,
      matches: libraryLocationMatches,
    };
  },
  {
    failureFunction: async ({ failResponse }) => {
      const error = sanitizeFailResponse(failResponse);
      return `Location matching failed: ${error}`;
    },
  }
);

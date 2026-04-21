import { talentMatchResponseSchema } from '../ai/response-schemas';
import { buildMatchingPromptVariables } from '../ai/talent-matching-prompt';
import { getGenerationChannel } from '../realtime';
import { sanitizeFailResponse } from '../workflow/sanitize-fail-response';
import { createScopedWorkflow } from '../workflow/scoped-workflow';
import type {
  TalentCharacterMatch,
  TalentMatchingWorkflowInput,
  TalentMatchingWorkflowOutput,
} from '../workflow/types';
import { durableLLMCall } from './llm-call-helper';

export const talentMatchingWorkflow = createScopedWorkflow<
  TalentMatchingWorkflowInput,
  TalentMatchingWorkflowOutput
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;
    const { analysisModelId, suggestedTalentIds } = input;
    const { sequenceId, userId, teamId } = input;

    const llmCallContext = {
      sequenceId,
      userId,
      teamId,
    };

    // Use pre-extracted bible from scene splitting, or fall back to LLM extraction
    const characterBible = input.characterBible;

    // Talent matching (conditional)
    const { talentList, matchingPromptVariables } = await context.run(
      'get-talent-list',
      async () => {
        if (!suggestedTalentIds?.length || !input.teamId) {
          return { talentList: [], matchingPromptVariables: {} };
        }
        const talentList = await scopedDb.talent.getByIds(suggestedTalentIds);
        return {
          talentList,
          matchingPromptVariables: buildMatchingPromptVariables(
            characterBible,
            talentList
          ),
        };
      }
    );

    const { matches: talentMatches } =
      talentList.length > 0
        ? await durableLLMCall(
            context,
            {
              name: 'talent-matching',
              phase: { number: 2, name: 'Casting characters…' },

              promptName: 'phase/talent-matching-chat',
              promptVariables: matchingPromptVariables,
              modelId: analysisModelId,
              responseSchema: talentMatchResponseSchema,
            },
            llmCallContext
          )
        : { matches: [] };

    const talentCharacterMatches: TalentCharacterMatch[] = await context.run(
      'build-matches',
      async () => {
        const usedTalentIds = new Set<string>();
        const matches: TalentCharacterMatch[] = [];

        for (const match of talentMatches) {
          // Ensure each talent is only cast once (but characters can have multiple talents
          // when there are more talents than characters)
          if (usedTalentIds.has(match.talentId)) {
            console.warn(
              `[TalentMatching] Skipping duplicate talent ${match.talentId}`
            );
            continue;
          }

          const talent = talentList.find((t) => t.id === match.talentId);
          if (!talent) {
            console.warn(
              `[TalentMatching] Talent ${match.talentId} not found in list`
            );
            continue;
          }

          const character = characterBible.find(
            (c) => c.characterId === match.characterId
          );
          if (!character) {
            console.warn(
              `[TalentMatching] Character ${match.characterId} not found in bible`
            );
            continue;
          }

          usedTalentIds.add(match.talentId);
          matches.push({
            characterId: match.characterId,
            talentId: match.talentId,
            talentName: talent.name,
            sheetImageUrl: talent.defaultSheet?.imageUrl ?? '',
            sheetMetadata: talent.defaultSheet?.metadata ?? undefined,
          });
        }

        if (matches.length > 0) {
          await getGenerationChannel(sequenceId).emit(
            'generation.talent:matched',
            {
              matches: matches.map((m) => {
                const char = characterBible.find(
                  (c) => c.characterId === m.characterId
                );
                return {
                  characterId: m.characterId,
                  characterName: char?.name ?? m.characterId,
                  talentId: m.talentId,
                  talentName: m.talentName,
                };
              }),
            }
          );
        }

        return matches;
      }
    );

    return {
      characterBible,
      matches: talentCharacterMatches,
    };
  },
  {
    failureFunction: async ({ failResponse }) => {
      const error = sanitizeFailResponse(failResponse);
      return `Talent matching failed: ${error}`;
    },
  }
);

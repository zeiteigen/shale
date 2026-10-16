import type { LinkageModel } from './linkage';

/**
 * Shipped weights so a fresh install can score pairs before it has labels of its own: logistic regression
 * fitted offline on 2,020 same/different model verdicts (1,821 same, 199 different) from a production queue.
 * `accountConflict` had no examples and is set by hand. Local refits shrink toward these weights.
 */
export const DEFAULT_LINKAGE_MODEL: LinkageModel = {"version":1,"bias":-2.7658,"weights":{"jw":-0.089,"jaccard":0.4637,"idf":-0.3553,"exact":1.5436,"contained":1.548,"rare":1.2275,"single":-0.2098,"acronym":-0.7265,"personCompatible":-0.3498,"personConflict":-1.3586,"personExact":-0.0975,"personSingle":1.1309,"emailName":-0.9514,"sameEmail":0.6142,"emailConflict":-1.0326,"sameDomain":0.2696,"accountConflict":-3,"coParticipant":-0.0368,"dateMatch":0.8072,"dateConflict":-1.4376,"numberConflict":-1.9148,"variant":-0.7092,"eventExact":-1.7109,"description":1.7587,"descriptionMissing":1.2822,"neighbors":-0.9661,"sharedNeighbors":2.0234,"sources":-0.444,"coMention":-3.7196,"origins":0.7153,"temporal":-0.3674,"gap":0.1417,"person":0.5546,"organization":1.6672,"concept":-0.3996,"event":-0.6066,"place":-0.6467,"work":-0.5689},"trainedAt":0,"labels":2020,"origin":"default"};

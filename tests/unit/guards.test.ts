import { describe, it, expect } from 'vitest';
import { detectShopMismatch, hasBroadDelegation, hasMultiBikeSignal, shopToken } from '../../src/modules/pipeline/guards.js';

const SHOPS = ['downtown', 'northside', 'lakeshore'];

describe('guard: broad delegation (m-1025)', () => {
  it('detects explicit broad-delegation phrasings', () => {
    for (const s of [
      'Whatever it needs.',
      'My bike has been sitting for years. Brakes, tires, chain all look rough. Whatever it needs. Monday.',
      'Please fix anything wrong with it.',
      'Do whatever is necessary.',
      'whatever you think is best',
      'honestly, do whatever needs doing',
    ]) expect(hasBroadDelegation(s)).toBe(true);
  });
  it('does NOT fire on specific or negated requests', () => {
    for (const s of [
      'I know exactly what I need: a basic tune-up.',
      'Just replace the chain, please.',
      "Please don't fix anything beyond the tune-up.",
      'No need to do anything else, only the brakes.',
      'Basic tune-up on my cargo bike before winter.',
    ]) expect(hasBroadDelegation(s)).toBe(false);
  });
  it('mixed intent (concrete + delegation) still flags delegation → inspection path', () => {
    expect(hasBroadDelegation('My chain is broken, and do whatever else it needs.')).toBe(true);
  });
});

describe('guard: shop mismatch (m-1009)', () => {
  it('flags a message addressing a different shop (all 3 combinations)', () => {
    expect(detectShopMismatch('Hi Lakeshore team! Following up on my visit.', 'downtown', SHOPS)).toBe(true);
    expect(detectShopMismatch('Hello Northside shop, can you help?', 'lakeshore', SHOPS)).toBe(true);
    expect(detectShopMismatch('Dear Downtown crew, my bike squeaks.', 'northside', SHOPS)).toBe(true);
  });
  it('does NOT flag the shop addressing itself', () => {
    expect(detectShopMismatch('Hi Downtown team, tune please.', 'downtown', SHOPS)).toBe(false);
  });
  it('does NOT flag ordinary geography (no shop-context word/greeting)', () => {
    expect(detectShopMismatch('I ride downtown every day on my commute.', 'northside', SHOPS)).toBe(false);
    expect(detectShopMismatch('I live near Lakeshore Drive by the park.', 'downtown', SHOPS)).toBe(false);
    expect(detectShopMismatch('My bike needs a tune-up before Saturday.', 'downtown', SHOPS)).toBe(false);
  });
  it('shopToken strips the rb- prefix', () => {
    expect(shopToken('rb-lakeshore')).toBe('lakeshore');
  });
});

describe('guard: multi-bike signal (m-1032)', () => {
  it('detects explicit multiple bikes', () => {
    for (const s of [
      'Basic tune-up for my daughter\'s bike and mine, two bikes.',
      'Please service both bikes.',
      'I have three bikes that need work.',
      'Can you look at our bikes?',
    ]) expect(hasMultiBikeSignal(s)).toBe(true);
  });
  it('does NOT fire on single-bike messages', () => {
    for (const s of [
      'Basic tune-up on my cargo bike before winter. Any weekday.',
      'My road bike needs a tune-up.',
      'Flat front tire on my kid\'s bike.',
    ]) expect(hasMultiBikeSignal(s)).toBe(false);
  });
});

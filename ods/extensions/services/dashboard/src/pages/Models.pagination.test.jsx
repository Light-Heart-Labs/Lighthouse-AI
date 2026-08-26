import { describe, test, expect } from 'vitest'
import { buildPageList } from './Models'

describe('buildPageList', () => {
  test('lists every page directly when pageCount is 5 or fewer', () => {
    expect(buildPageList(1, 5)).toEqual([1, 2, 3, 4, 5])
    expect(buildPageList(3, 5)).toEqual([1, 2, 3, 4, 5])
    expect(buildPageList(1, 1)).toEqual([1])
  })

  test('shows the first 3 pages, a gap, then the last page near the start', () => {
    expect(buildPageList(1, 20)).toEqual([1, 2, 3, 'gap', 20])
    expect(buildPageList(3, 20)).toEqual([1, 2, 3, 'gap', 20])
  })

  test('shows the first page, a gap, then the last 3 pages near the end', () => {
    expect(buildPageList(20, 20)).toEqual([1, 'gap', 18, 19, 20])
    expect(buildPageList(18, 20)).toEqual([1, 'gap', 18, 19, 20])
  })

  test('shows first page, gap, current page, gap, last page in the middle', () => {
    expect(buildPageList(10, 20)).toEqual([1, 'gap', 10, 'gap', 20])
  })

  test('the boundary between "near start" and "middle" is at page 4', () => {
    // page<=3 takes the near-start branch; page 4 is the first to fall
    // through to the middle branch.
    expect(buildPageList(4, 20)).toEqual([1, 'gap', 4, 'gap', 20])
  })

  test('the boundary between "middle" and "near end" is at pageCount-2', () => {
    // page>=pageCount-2 takes the near-end branch (pageCount=20 -> page 18).
    expect(buildPageList(17, 20)).toEqual([1, 'gap', 17, 'gap', 20])
    expect(buildPageList(18, 20)).toEqual([1, 'gap', 18, 19, 20])
  })
})

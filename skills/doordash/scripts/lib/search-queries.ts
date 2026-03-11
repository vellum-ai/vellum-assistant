/**
 * GraphQL queries for DoorDash search and homepage discovery.
 * Each query is fully self-contained with all required fragment definitions.
 */

// ---------------------------------------------------------------------------
// SEARCH_QUERY
// ---------------------------------------------------------------------------

export const SEARCH_QUERY = `
query autocompleteFacetFeed($query: String!, $serializedBundleGlobalSearchContext: String) {
  autocompleteFacetFeed(
    query: $query
    serializedBundleGlobalSearchContext: $serializedBundleGlobalSearchContext
  ) {
    ...FacetFeedV2ResultFragment
    __typename
  }
}

fragment FacetFeedV2ResultFragment on FacetFeedV2Result {
  body {
    id
    header { ...FacetV2Fragment __typename }
    body { ...FacetV2Fragment __typename }
    layout { omitFooter __typename }
    __typename
  }
  page { ...FacetV2PageFragment __typename }
  header { ...FacetV2Fragment __typename }
  footer { ...FacetV2Fragment __typename }
  custom logging __typename
}

fragment FacetV2Fragment on FacetV2 {
  ...FacetV2BaseFragment
  childrenMap { ...FacetV2BaseFragment __typename }
  __typename
}

fragment FacetV2BaseFragment on FacetV2 {
  id childrenCount
  component { id category __typename }
  name
  text {
    title
    titleTextAttributes { textStyle textColor __typename }
    subtitle
    subtitleTextAttributes { textStyle textColor __typename }
    accessory
    accessoryTextAttributes { textStyle textColor __typename }
    description
    descriptionTextAttributes { textStyle textColor __typename }
    custom { key value __typename }
    __typename
  }
  images {
    main { ...FacetV2ImageFragment __typename }
    icon { ...FacetV2ImageFragment __typename }
    background { ...FacetV2ImageFragment __typename }
    accessory { ...FacetV2ImageFragment __typename }
    custom { key value { ...FacetV2ImageFragment __typename } __typename }
    __typename
  }
  events { click { name data __typename } __typename }
  style {
    spacing background_color
    border { color width style __typename }
    sizeClass dlsType __typename
  }
  layout {
    omitFooter
    gridSpecs {
      Mobile { ...FacetV2LayoutGridFragment __typename }
      Phablet { ...FacetV2LayoutGridFragment __typename }
      Tablet { ...FacetV2LayoutGridFragment __typename }
      Desktop { ...FacetV2LayoutGridFragment __typename }
      WideScreen { ...FacetV2LayoutGridFragment __typename }
      UltraWideScreen { ...FacetV2LayoutGridFragment __typename }
      __typename
    }
    dlsPadding { top right bottom left __typename }
    __typename
  }
  custom logging __typename
}

fragment FacetV2ImageFragment on FacetV2Image {
  uri videoUri placeholder local style logging
  events { click { name data __typename } __typename }
  __typename
}

fragment FacetV2LayoutGridFragment on FacetV2LayoutGrid {
  interRowSpacing interColumnSpacing minDimensionCount __typename
}

fragment FacetV2PageFragment on FacetV2Page {
  next { name data __typename }
  onLoad { name data __typename }
  __typename
}`;

// ---------------------------------------------------------------------------
// HOME_PAGE_QUERY
// ---------------------------------------------------------------------------

export const HOME_PAGE_QUERY = `
query homePageFacetFeed($cursor: String, $filterQuery: String, $displayHeader: Boolean, $isDebug: Boolean, $cuisineFilterVerticalIds: String) {
  homePageFacetFeed(
    cursor: $cursor
    filterQuery: $filterQuery
    displayHeader: $displayHeader
    isDebug: $isDebug
    cuisineFilterVerticalIds: $cuisineFilterVerticalIds
  ) {
    ...FacetFeedV2ResultFragment
    __typename
  }
}

fragment FacetFeedV2ResultFragment on FacetFeedV2Result {
  body {
    id
    header { ...FacetV2Fragment __typename }
    body { ...FacetV2Fragment __typename }
    layout { omitFooter __typename }
    __typename
  }
  page { ...FacetV2PageFragment __typename }
  header { ...FacetV2Fragment __typename }
  footer { ...FacetV2Fragment __typename }
  custom logging __typename
}

fragment FacetV2Fragment on FacetV2 {
  ...FacetV2BaseFragment
  childrenMap { ...FacetV2BaseFragment __typename }
  __typename
}

fragment FacetV2BaseFragment on FacetV2 {
  id childrenCount
  component { id category __typename }
  name
  text {
    title
    titleTextAttributes { textStyle textColor __typename }
    subtitle
    subtitleTextAttributes { textStyle textColor __typename }
    accessory
    accessoryTextAttributes { textStyle textColor __typename }
    description
    descriptionTextAttributes { textStyle textColor __typename }
    custom { key value __typename }
    __typename
  }
  images {
    main { ...FacetV2ImageFragment __typename }
    icon { ...FacetV2ImageFragment __typename }
    background { ...FacetV2ImageFragment __typename }
    accessory { ...FacetV2ImageFragment __typename }
    custom { key value { ...FacetV2ImageFragment __typename } __typename }
    __typename
  }
  events { click { name data __typename } __typename }
  style {
    spacing background_color
    border { color width style __typename }
    sizeClass dlsType __typename
  }
  layout {
    omitFooter
    gridSpecs {
      Mobile { ...FacetV2LayoutGridFragment __typename }
      Phablet { ...FacetV2LayoutGridFragment __typename }
      Tablet { ...FacetV2LayoutGridFragment __typename }
      Desktop { ...FacetV2LayoutGridFragment __typename }
      WideScreen { ...FacetV2LayoutGridFragment __typename }
      UltraWideScreen { ...FacetV2LayoutGridFragment __typename }
      __typename
    }
    dlsPadding { top right bottom left __typename }
    __typename
  }
  custom logging __typename
}

fragment FacetV2ImageFragment on FacetV2Image {
  uri videoUri placeholder local style logging
  events { click { name data __typename } __typename }
  __typename
}

fragment FacetV2LayoutGridFragment on FacetV2LayoutGrid {
  interRowSpacing interColumnSpacing minDimensionCount __typename
}

fragment FacetV2PageFragment on FacetV2Page {
  next { name data __typename }
  onLoad { name data __typename }
  __typename
}`;

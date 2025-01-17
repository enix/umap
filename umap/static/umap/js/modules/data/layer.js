// Uses U.FormBuilder not available as ESM

// FIXME: this module should not depend on Leaflet
import {
  DomUtil,
  DomEvent,
  stamp,
  GeoJSON,
} from '../../../vendors/leaflet/leaflet-src.esm.js'
import * as Utils from '../utils.js'
import { Default as DefaultLayer } from '../rendering/layers/base.js'
import { Cluster } from '../rendering/layers/cluster.js'
import { Heat } from '../rendering/layers/heat.js'
import { Categorized, Choropleth, Circles } from '../rendering/layers/classified.js'
import {
  uMapAlert as Alert,
  uMapAlertConflict as AlertConflict,
} from '../../components/alerts/alert.js'
import { translate } from '../i18n.js'
import { DataLayerPermissions } from '../permissions.js'
import { Point, LineString, Polygon } from './features.js'
import TableEditor from '../tableeditor.js'
import { ServerStored } from '../saving.js'
import * as Schema from '../schema.js'

export const LAYER_TYPES = [
  DefaultLayer,
  Cluster,
  Heat,
  Choropleth,
  Categorized,
  Circles,
]

const LAYER_MAP = LAYER_TYPES.reduce((acc, klass) => {
  acc[klass.TYPE] = klass
  return acc
}, {})

export class DataLayer extends ServerStored {
  constructor(umap, leafletMap, data = {}) {
    super()
    this._umap = umap
    this.sync = umap.sync_engine.proxy(this)
    this._index = Array()
    this._features = {}
    this._geojson = null
    this._propertiesIndex = []
    this._loaded = false // Are layer metadata loaded
    this._dataloaded = false // Are layer data loaded

    this._leafletMap = leafletMap
    this.parentPane = this._leafletMap.getPane('overlayPane')
    this.pane = this._leafletMap.createPane(`datalayer${stamp(this)}`, this.parentPane)
    this.pane.dataset.id = stamp(this)
    // FIXME: should be on layer
    this.renderer = L.svg({ pane: this.pane })
    this.defaultOptions = {
      displayOnLoad: true,
      inCaption: true,
      browsable: true,
      editMode: 'advanced',
    }

    this._isDeleted = false
    this._referenceVersion = data._referenceVersion
    // Do not save it later.
    delete data._referenceVersion
    data.id = data.id || crypto.randomUUID()

    this.setOptions(data)

    if (!Utils.isObject(this.options.remoteData)) {
      this.options.remoteData = {}
    }
    // Retrocompat
    if (this.options.remoteData?.from) {
      this.options.fromZoom = this.options.remoteData.from
      delete this.options.remoteData.from
    }
    if (this.options.remoteData?.to) {
      this.options.toZoom = this.options.remoteData.to
      delete this.options.remoteData.to
    }
    this.backupOptions()
    this.connectToMap()
    this.permissions = new DataLayerPermissions(this._umap, this)

    if (!this.createdOnServer) {
      if (this.showAtLoad()) this.show()
      this.isDirty = true
    }

    // Only layers that are displayed on load must be hidden/shown
    // Automatically, others will be shown manually, and thus will
    // be in the "forced visibility" mode
    if (this.isVisible()) this.propagateShow()
  }

  get id() {
    return this.options.id
  }

  get createdOnServer() {
    return Boolean(this._referenceVersion)
  }

  onDirty(status) {
    if (status) {
      // A layer can be made dirty by indirect action (like dragging layers)
      // we need to have it loaded before saving it.
      if (!this.isLoaded()) this.fetchData()
    } else {
      this.isDeleted = false
    }
  }

  set isDeleted(status) {
    this._isDeleted = status
    if (status) this.isDirty = status
  }

  get isDeleted() {
    return this._isDeleted
  }

  get cssId() {
    return `datalayer-${stamp(this)}`
  }

  getSyncMetadata() {
    return {
      subject: 'datalayer',
      metadata: { id: this.id },
    }
  }

  render(fields, builder) {
    const impacts = Utils.getImpactsFromSchema(fields)

    for (const impact of impacts) {
      switch (impact) {
        case 'ui':
          this._umap.onDataLayersChanged()
          break
        case 'data':
          if (fields.includes('options.type')) {
            this.resetLayer()
          }
          this.hide()
          for (const field of fields) {
            this.layer.onEdit(field, builder)
          }
          this.redraw()
          this.show()
          break
        case 'remote-data':
          this.fetchRemoteData()
          break
      }
    }
  }

  showAtLoad() {
    return this.autoLoaded() && this.showAtZoom()
  }

  autoLoaded() {
    if (!this._umap.datalayersFromQueryString) return this.options.displayOnLoad
    const datalayerIds = this._umap.datalayersFromQueryString
    let loadMe = datalayerIds.includes(this.id.toString())
    if (this.options.old_id) {
      loadMe = loadMe || datalayerIds.includes(this.options.old_id.toString())
    }
    return loadMe
  }

  insertBefore(other) {
    if (!other) return
    this.parentPane.insertBefore(this.pane, other.pane)
  }

  insertAfter(other) {
    if (!other) return
    this.parentPane.insertBefore(this.pane, other.pane.nextSibling)
  }

  bringToTop() {
    this.parentPane.appendChild(this.pane)
  }

  hasDataVisible() {
    return this.layer.hasDataVisible()
  }

  resetLayer(force) {
    // Only reset if type is defined (undefined is the default) and different from current type
    if (
      this.layer &&
      (!this.options.type || this.options.type === this.layer.getType()) &&
      !force
    ) {
      return
    }
    const visible = this.isVisible()
    if (this.layer) this.layer.clearLayers()
    // delete this.layer?
    if (visible) this._leafletMap.removeLayer(this.layer)
    const Class = LAYER_MAP[this.options.type] || DefaultLayer
    this.layer = new Class(this)
    // Rendering layer changed, so let's force reset the feature rendering too.
    this.eachFeature((feature) => feature.makeUI())
    this.eachFeature(this.showFeature)
    if (visible) this.show()
    this.propagateRemote()
  }

  eachFeature(method, context) {
    for (const idx of this._index) {
      method.call(context || this, this._features[idx])
    }
    return this
  }

  async fetchData() {
    if (!this.createdOnServer) return
    if (this._loading) return
    this._loading = true
    const [geojson, response, error] = await this._umap.server.get(this._dataUrl())
    if (!error) {
      this.setReferenceVersion({ response, sync: false })
      // FIXME: for now the _umap_options property is set dynamically from backend
      // And thus it's not in the geojson file in the server
      // So do not let all options to be reset
      // Fix is a proper migration so all datalayers settings are
      // in DB, and we remove it from geojson flat files.
      if (geojson._umap_options) {
        geojson._umap_options.editMode = this.options.editMode
      }
      // In case of maps pre 1.0 still around
      if (geojson._storage) geojson._storage.editMode = this.options.editMode
      await this.fromUmapGeoJSON(geojson)
      this.backupOptions()
      this._loading = false
    }
  }

  dataChanged() {
    if (!this.hasDataLoaded()) return
    this._umap.onDataLayersChanged()
    this.layer.dataChanged()
  }

  fromGeoJSON(geojson, sync = true) {
    this.addData(geojson, sync)
    this._geojson = geojson
    this.onDataLoaded()
    this.dataChanged()
  }

  onDataLoaded() {
    this._dataloaded = true
    this.renderLegend()
  }

  async fromUmapGeoJSON(geojson) {
    if (geojson._storage) geojson._umap_options = geojson._storage // Retrocompat
    geojson._umap_options.id = this.id
    if (geojson._umap_options) this.setOptions(geojson._umap_options)
    if (this.isRemoteLayer()) await this.fetchRemoteData()
    else this.fromGeoJSON(geojson, false)
    this._loaded = true
  }

  clear() {
    this.layer.clearLayers()
    this._features = {}
    this._index = Array()
    if (this._geojson) {
      this.backupData()
      this._geojson = null
    }
    this.dataChanged()
  }

  backupData() {
    this._geojson_bk = Utils.CopyJSON(this._geojson)
  }

  reindex() {
    const features = Object.values(this._features)
    Utils.sortFeatures(features, this._umap.getProperty('sortKey'), U.lang)
    this._index = features.map((feature) => stamp(feature))
  }

  showAtZoom() {
    const from = Number.parseInt(this.options.fromZoom, 10)
    const to = Number.parseInt(this.options.toZoom, 10)
    const zoom = this._leafletMap.getZoom()
    return !((!Number.isNaN(from) && zoom < from) || (!Number.isNaN(to) && zoom > to))
  }

  hasDynamicData() {
    return this.isRemoteLayer() && Boolean(this.options.remoteData?.dynamic)
  }

  async fetchRemoteData(force) {
    if (!this.isRemoteLayer()) return
    if (!this.hasDynamicData() && this.hasDataLoaded() && !force) return
    if (!this.isVisible()) return
    let url = this._umap.renderUrl(this.options.remoteData.url)
    if (this.options.remoteData.proxy) {
      url = this._umap.proxyUrl(url, this.options.remoteData.ttl)
    }
    const response = await this._umap.request.get(url)
    if (response?.ok) {
      this.clear()
      this._umap.formatter
        .parse(await response.text(), this.options.remoteData.format)
        .then((geojson) => this.fromGeoJSON(geojson))
    }
  }

  isLoaded() {
    return !this.createdOnServer || this._loaded
  }

  hasDataLoaded() {
    return this._dataloaded
  }

  backupOptions() {
    this._backupOptions = Utils.CopyJSON(this.options)
  }

  resetOptions() {
    this.options = Utils.CopyJSON(this._backupOptions)
  }

  setOptions(options) {
    delete options.geojson
    this.options = Utils.CopyJSON(this.defaultOptions) // Start from fresh.
    this.updateOptions(options)
  }

  updateOptions(options) {
    this.options = Object.assign(this.options, options)
    this.resetLayer()
  }

  connectToMap() {
    const id = stamp(this)
    if (!this._umap.datalayers[id]) {
      this._umap.datalayers[id] = this
    }
    if (!this._umap.datalayersIndex.includes(this)) {
      this._umap.datalayersIndex.push(this)
    }
    this._umap.onDataLayersChanged()
  }

  _dataUrl() {
    let url = this._umap.urls.get('datalayer_view', {
      pk: this.id,
      map_id: this._umap.id,
    })

    // No browser cache for owners/editors.
    if (this._umap.hasEditMode()) url = `${url}?${Date.now()}`
    return url
  }

  isRemoteLayer() {
    return Boolean(this.options.remoteData?.url && this.options.remoteData.format)
  }

  isClustered() {
    return this.options.type === 'Cluster'
  }

  showFeature(feature) {
    if (feature.isFiltered()) return
    this.layer.addLayer(feature.ui)
  }

  hideFeature(feature) {
    this.layer.removeLayer(feature.ui)
  }

  addFeature(feature) {
    const id = stamp(feature)
    feature.connectToDataLayer(this)
    this._index.push(id)
    this._features[id] = feature
    this.indexProperties(feature)
    this._umap.featuresIndex[feature.getSlug()] = feature
    this.showFeature(feature)
    this.dataChanged()
  }

  removeFeature(feature, sync) {
    const id = stamp(feature)
    if (sync !== false) feature.sync.delete()
    this.hideFeature(feature)
    delete this._umap.featuresIndex[feature.getSlug()]
    feature.disconnectFromDataLayer(this)
    this._index.splice(this._index.indexOf(id), 1)
    delete this._features[id]
    if (this.isVisible()) this.dataChanged()
  }

  indexProperties(feature) {
    for (const i in feature.properties)
      if (typeof feature.properties[i] !== 'object') this.indexProperty(i)
  }

  indexProperty(name) {
    if (!name) return
    if (name.indexOf('_') === 0) return
    if (!this._propertiesIndex.includes(name)) {
      this._propertiesIndex.push(name)
      this._propertiesIndex.sort()
    }
  }

  deindexProperty(name) {
    const idx = this._propertiesIndex.indexOf(name)
    if (idx !== -1) this._propertiesIndex.splice(idx, 1)
  }

  sortedValues(property) {
    return Object.values(this._features)
      .map((feature) => feature.properties[property])
      .filter((val, idx, arr) => arr.indexOf(val) === idx)
      .sort(Utils.naturalSort)
  }

  addData(geojson, sync) {
    try {
      // Do not fail if remote data is somehow invalid,
      // otherwise the layer becomes uneditable.
      this.makeFeatures(geojson, sync)
    } catch (err) {
      console.log('Error with DataLayer', this.id)
      console.error(err)
    }
  }

  makeFeatures(geojson = {}, sync = true) {
    if (geojson.type === 'Feature' || geojson.coordinates) {
      geojson = [geojson]
    }
    const collection = Array.isArray(geojson)
      ? geojson
      : geojson.features || geojson.geometries
    if (!collection) return
    Utils.sortFeatures(collection, this._umap.getProperty('sortKey'), U.lang)
    for (const feature of collection) {
      this.makeFeature(feature, sync)
    }
  }

  makeFeature(geojson = {}, sync = true, id = null) {
    // Both Feature and Geometry are valid geojson objects.
    const geometry = geojson.geometry || geojson
    let feature

    switch (geometry.type) {
      case 'Point':
        // FIXME: deal with MultiPoint
        feature = new Point(this._umap, this, geojson, id)
        break
      case 'MultiLineString':
      case 'LineString':
        feature = new LineString(this._umap, this, geojson, id)
        break
      case 'MultiPolygon':
      case 'Polygon':
        feature = new Polygon(this._umap, this, geojson, id)
        break
      default:
        console.log(geojson)
        Alert.error(
          translate('Skipping unknown geometry.type: {type}', {
            type: geometry.type || 'undefined',
          })
        )
    }
    if (feature) {
      this.addFeature(feature)
      if (sync) feature.onCommit()
      return feature
    }
  }

  async importRaw(raw, format) {
    this._umap.formatter
      .parse(raw, format)
      .then((geojson) => this.addData(geojson))
      .then(() => this.zoomTo())
    this.isDirty = true
  }

  importFromFiles(files, type) {
    for (const f of files) {
      this.importFromFile(f, type)
    }
  }

  importFromFile(f, type) {
    const reader = new FileReader()
    type = type || Utils.detectFileType(f)
    reader.readAsText(f)
    reader.onload = (e) => this.importRaw(e.target.result, type)
  }

  async importFromUrl(uri, type) {
    uri = this._umap.renderUrl(uri)
    const response = await this._umap.request.get(uri)
    if (response?.ok) {
      this.importRaw(await response.text(), type)
    }
  }

  getColor() {
    return this.options.color || this._umap.getProperty('color')
  }

  getDeleteUrl() {
    return this._umap.urls.get('datalayer_delete', {
      pk: this.id,
      map_id: this._umap.id,
    })
  }

  getVersionsUrl() {
    return this._umap.urls.get('datalayer_versions', {
      pk: this.id,
      map_id: this._umap.id,
    })
  }

  getVersionUrl(name) {
    return this._umap.urls.get('datalayer_version', {
      pk: this.id,
      map_id: this._umap.id,
      name: name,
    })
  }

  _delete() {
    this.isDeleted = true
    this.erase()
  }

  empty() {
    if (this.isRemoteLayer()) return
    this.clear()
    this.isDirty = true
  }

  clone() {
    const options = Utils.CopyJSON(this.options)
    options.name = translate('Clone of {name}', { name: this.options.name })
    delete options.id
    const geojson = Utils.CopyJSON(this._geojson)
    const datalayer = this._umap.createDataLayer(options)
    datalayer.fromGeoJSON(geojson)
    return datalayer
  }

  erase() {
    this.hide()
    this._umap.datalayersIndex.splice(this.getRank(), 1)
    this.parentPane.removeChild(this.pane)
    this._umap.onDataLayersChanged()
    this.layer.onDelete(this._leafletMap)
    this.propagateDelete()
    this._leaflet_events_bk = this._leaflet_events
    this.clear()
    delete this._loaded
    delete this._dataloaded
  }

  reset() {
    if (!this.createdOnServer) this.erase()

    this.resetOptions()
    this.parentPane.appendChild(this.pane)
    if (this._leaflet_events_bk && !this._leaflet_events) {
      this._leaflet_events = this._leaflet_events_bk
    }
    this.clear()
    this.hide()
    if (this.isRemoteLayer()) this.fetchRemoteData()
    else if (this._geojson_bk) this.fromGeoJSON(this._geojson_bk)
    this._loaded = true
    this.show()
    this.isDirty = false
  }

  redraw() {
    if (!this.isVisible()) return
    this.hide()
    this.show()
  }

  edit() {
    if (!this._umap.editEnabled || !this.isLoaded()) {
      return
    }
    const container = DomUtil.create('div', 'umap-layer-properties-container')
    const metadataFields = [
      'options.name',
      'options.description',
      [
        'options.type',
        { handler: 'LayerTypeChooser', label: translate('Type of layer') },
      ],
      [
        'options.displayOnLoad',
        { label: translate('Display on load'), handler: 'Switch' },
      ],
      [
        'options.browsable',
        {
          label: translate('Data is browsable'),
          handler: 'Switch',
          helpEntries: 'browsable',
        },
      ],
      [
        'options.inCaption',
        {
          label: translate('Show this layer in the caption'),
          handler: 'Switch',
        },
      ],
    ]
    DomUtil.createTitle(container, translate('Layer properties'), 'icon-layers')
    let builder = new U.FormBuilder(this, metadataFields, {
      callback(e) {
        this._umap.onDataLayersChanged()
        if (e.helper.field === 'options.type') {
          this.edit()
        }
      },
    })
    container.appendChild(builder.build())

    const layerOptions = this.layer.getEditableOptions()

    if (layerOptions.length) {
      builder = new U.FormBuilder(this, layerOptions, {
        id: 'datalayer-layer-properties',
      })
      const layerProperties = DomUtil.createFieldset(
        container,
        `${this.layer.getName()}: ${translate('settings')}`
      )
      layerProperties.appendChild(builder.build())
    }

    const shapeOptions = [
      'options.color',
      'options.iconClass',
      'options.iconUrl',
      'options.iconOpacity',
      'options.opacity',
      'options.stroke',
      'options.weight',
      'options.fill',
      'options.fillColor',
      'options.fillOpacity',
    ]

    builder = new U.FormBuilder(this, shapeOptions, {
      id: 'datalayer-advanced-properties',
    })
    const shapeProperties = DomUtil.createFieldset(
      container,
      translate('Shape properties')
    )
    shapeProperties.appendChild(builder.build())

    const optionsFields = [
      'options.smoothFactor',
      'options.dashArray',
      'options.zoomTo',
      'options.fromZoom',
      'options.toZoom',
      'options.labelKey',
    ]

    builder = new U.FormBuilder(this, optionsFields, {
      id: 'datalayer-advanced-properties',
    })
    const advancedProperties = DomUtil.createFieldset(
      container,
      translate('Advanced properties')
    )
    advancedProperties.appendChild(builder.build())

    const popupFields = [
      'options.popupShape',
      'options.popupTemplate',
      'options.popupContentTemplate',
      'options.showLabel',
      'options.labelDirection',
      'options.labelInteractive',
      'options.outlinkTarget',
      'options.interactive',
    ]
    builder = new U.FormBuilder(this, popupFields)
    const popupFieldset = DomUtil.createFieldset(
      container,
      translate('Interaction options')
    )
    popupFieldset.appendChild(builder.build())

    // XXX I'm not sure **why** this is needed (as it's set during `this.initialize`)
    // but apparently it's needed.
    if (!Utils.isObject(this.options.remoteData)) {
      this.options.remoteData = {}
    }

    const remoteDataFields = [
      [
        'options.remoteData.url',
        { handler: 'Url', label: translate('Url'), helpEntries: ['formatURL'] },
      ],
      [
        'options.remoteData.format',
        { handler: 'DataFormat', label: translate('Format') },
      ],
      'options.fromZoom',
      'options.toZoom',
      [
        'options.remoteData.dynamic',
        {
          handler: 'Switch',
          label: translate('Dynamic'),
          helpEntries: ['dynamicRemoteData'],
        },
      ],
      [
        'options.remoteData.licence',
        {
          label: translate('Licence'),
          helpText: translate('Please be sure the licence is compliant with your use.'),
        },
      ],
    ]
    if (this._umap.properties.urls.ajax_proxy) {
      remoteDataFields.push([
        'options.remoteData.proxy',
        {
          handler: 'Switch',
          label: translate('Proxy request'),
          helpEntries: ['proxyRemoteData'],
        },
      ])
      remoteDataFields.push('options.remoteData.ttl')
    }

    const remoteDataContainer = DomUtil.createFieldset(
      container,
      translate('Remote data')
    )
    builder = new U.FormBuilder(this, remoteDataFields)
    remoteDataContainer.appendChild(builder.build())
    DomUtil.createButton(
      'button umap-verify',
      remoteDataContainer,
      translate('Verify remote URL'),
      () => this.fetchRemoteData(true),
      this
    )

    if (this._umap.properties.urls.datalayer_versions)
      this.buildVersionsFieldset(container)

    const advancedActions = DomUtil.createFieldset(
      container,
      translate('Advanced actions')
    )
    const advancedButtons = DomUtil.create('div', 'button-bar half', advancedActions)
    const deleteButton = Utils.loadTemplate(`
      <button class="button" type="button">
        <i class="icon icon-24 icon-delete"></i>${translate('Delete')}
      </button>`)
    deleteButton.addEventListener('click', () => {
      this._delete()
      this._umap.editPanel.close()
    })
    advancedButtons.appendChild(deleteButton)

    if (!this.isRemoteLayer()) {
      const emptyLink = DomUtil.createButton(
        'button umap-empty',
        advancedButtons,
        translate('Empty'),
        this.empty,
        this
      )
    }
    const cloneLink = DomUtil.createButton(
      'button umap-clone',
      advancedButtons,
      translate('Clone'),
      function () {
        const datalayer = this.clone()
        datalayer.edit()
      },
      this
    )
    if (this.createdOnServer) {
      const filename = `${Utils.slugify(this.options.name)}.geojson`
      const download = Utils.loadTemplate(`
        <a class="button" href="${this._dataUrl()}" download="${filename}">
          <i class="icon icon-24 icon-download"></i>${translate('Download')}
        </a>`)
      advancedButtons.appendChild(download)
    }
    const backButton = DomUtil.createButtonIcon(
      undefined,
      'icon-back',
      translate('Back to layers')
    )
    // Fixme: remove me when this is merged and released
    // https://github.com/Leaflet/Leaflet/pull/9052
    DomEvent.disableClickPropagation(backButton)
    DomEvent.on(backButton, 'click', this._umap.editDatalayers, this._umap)

    this._umap.editPanel.open({
      content: container,
      actions: [backButton],
    })
  }

  getOwnOption(option) {
    if (Utils.usableOption(this.options, option)) return this.options[option]
  }

  getOption(option, feature) {
    if (this.layer?.getOption) {
      const value = this.layer.getOption(option, feature)
      if (value !== undefined) return value
    }
    if (this.getOwnOption(option) !== undefined) {
      return this.getOwnOption(option)
    }
    if (this.layer?.defaults?.[option]) {
      return this.layer.defaults[option]
    }
    return this._umap.getProperty(option, feature)
  }

  async buildVersionsFieldset(container) {
    const appendVersion = (data) => {
      const date = new Date(Number.parseInt(data.at, 10))
      const content = `${date.toLocaleString(U.lang)} (${Number.parseInt(data.size) / 1000}Kb)`
      const el = DomUtil.create('div', 'umap-datalayer-version', versionsContainer)
      const button = DomUtil.createButton(
        '',
        el,
        '',
        () => this.restore(data.name),
        this
      )
      button.title = translate('Restore this version')
      DomUtil.add('span', '', el, content)
    }

    const versionsContainer = DomUtil.createFieldset(container, translate('Versions'), {
      async callback() {
        const [{ versions }, response, error] = await this._umap.server.get(
          this.getVersionsUrl()
        )
        if (!error) versions.forEach(appendVersion)
      },
      context: this,
    })
  }

  async restore(version) {
    if (!this._umap.editEnabled) return
    this._umap.dialog
      .confirm(translate('Are you sure you want to restore this version?'))
      .then(async () => {
        const [geojson, response, error] = await this._umap.server.get(
          this.getVersionUrl(version)
        )
        if (!error) {
          if (geojson._storage) geojson._umap_options = geojson._storage // Retrocompat.
          if (geojson._umap_options) this.setOptions(geojson._umap_options)
          this.empty()
          if (this.isRemoteLayer()) this.fetchRemoteData()
          else this.addData(geojson)
          this.isDirty = true
        }
      })
  }

  featuresToGeoJSON() {
    const features = []
    this.eachFeature((feature) => features.push(feature.toGeoJSON()))
    return features
  }

  async show() {
    this._leafletMap.addLayer(this.layer)
    if (!this.isLoaded()) await this.fetchData()
    this.propagateShow()
  }

  hide() {
    this._leafletMap.removeLayer(this.layer)
    this.propagateHide()
  }

  toggle() {
    // From now on, do not try to how/hidedataChanged
    // automatically this layer.
    this._forcedVisibility = true
    if (!this.isVisible()) this.show()
    else this.hide()
  }

  zoomTo() {
    if (!this.isVisible()) return
    const bounds = this.layer.getBounds()
    if (bounds.isValid()) {
      const options = { maxZoom: this.getOption('zoomTo') }
      this._leafletMap.fitBounds(bounds, options)
    }
  }

  // Is this layer type browsable in theorie
  isBrowsable() {
    return this.layer?.browsable
  }

  // Is this layer browsable in theorie
  // AND the user allows it
  allowBrowse() {
    return !!this.options.browsable && this.isBrowsable()
  }

  // Is this layer browsable in theorie
  // AND the user allows it
  // AND it makes actually sense (is visible, it has data…)
  canBrowse() {
    return this.allowBrowse() && this.isVisible() && this.hasData()
  }

  count() {
    return this._index.length
  }

  hasData() {
    return !!this._index.length
  }

  isVisible() {
    return Boolean(this.layer && this._leafletMap.hasLayer(this.layer))
  }

  getFeatureByIndex(index) {
    if (index === -1) index = this._index.length - 1
    const id = this._index[index]
    return this._features[id]
  }

  // TODO Add an index
  // For now, iterate on all the features.
  getFeatureById(id) {
    return Object.values(this._features).find((feature) => feature.id === id)
  }

  getNextFeature(feature) {
    const id = this._index.indexOf(stamp(feature))
    const nextId = this._index[id + 1]
    return nextId
      ? this._features[nextId]
      : this.getNextBrowsable().getFeatureByIndex(0)
  }

  getPreviousFeature(feature) {
    if (this._index <= 1) {
      return null
    }
    const id = this._index.indexOf(stamp(feature))
    const previousId = this._index[id - 1]
    return previousId
      ? this._features[previousId]
      : this.getPreviousBrowsable().getFeatureByIndex(-1)
  }

  getPreviousBrowsable() {
    let id = this.getRank()
    let next
    const index = this._umap.datalayersIndex
    while (((id = index[++id] ? id : 0), (next = index[id]))) {
      if (next === this || next.canBrowse()) break
    }
    return next
  }

  getNextBrowsable() {
    let id = this.getRank()
    let prev
    const index = this._umap.datalayersIndex
    while (((id = index[--id] ? id : index.length - 1), (prev = index[id]))) {
      if (prev === this || prev.canBrowse()) break
    }
    return prev
  }

  umapGeoJSON() {
    return {
      type: 'FeatureCollection',
      features: this.isRemoteLayer() ? [] : this.featuresToGeoJSON(),
      _umap_options: this.options,
    }
  }

  getRank() {
    return this._umap.datalayersIndex.indexOf(this)
  }

  isReadOnly() {
    // isReadOnly must return true if unset
    return this.options.editMode === 'disabled'
  }

  isDataReadOnly() {
    // This layer cannot accept features
    return this.isReadOnly() || this.isRemoteLayer()
  }

  setReferenceVersion({ response, sync }) {
    this._referenceVersion = response.headers.get('X-Datalayer-Version')
    this.sync.update('_referenceVersion', this._referenceVersion)
  }

  async save() {
    if (this.isDeleted) return await this.saveDelete()
    if (!this.isLoaded()) {
      return
    }
    const geojson = this.umapGeoJSON()
    const formData = new FormData()
    formData.append('name', this.options.name)
    formData.append('display_on_load', !!this.options.displayOnLoad)
    formData.append('rank', this.getRank())
    formData.append('settings', JSON.stringify(this.options))
    // Filename support is shaky, don't do it for now.
    const blob = new Blob([JSON.stringify(geojson)], { type: 'application/json' })
    formData.append('geojson', blob)
    const saveURL = this._umap.urls.get('datalayer_save', {
      map_id: this._umap.id,
      pk: this.id,
      created: this.createdOnServer,
    })
    const headers = this._referenceVersion
      ? { 'X-Datalayer-Reference': this._referenceVersion }
      : {}
    const status = await this._trySave(saveURL, headers, formData)
    this._geojson = geojson
    return status
  }

  async _trySave(url, headers, formData) {
    const [data, response, error] = await this._umap.server.post(url, headers, formData)
    if (error) {
      if (response && response.status === 412) {
        AlertConflict.error(
          translate(
            'Whoops! Other contributor(s) changed some of the same map elements as you. ' +
              'This situation is tricky, you have to choose carefully which version is pertinent.'
          ),
          async () => {
            // Save again this layer
            const status = await this._trySave(url, {}, formData)
            if (status) {
              this.isDirty = false

              // Call the main save, in case something else needs to be saved
              // as the conflict stopped the saving flow
              await this._umap.saveAll()
            }
          }
        )
      }
    } else {
      // Response contains geojson only if save has conflicted and conflicts have
      // been resolved. So we need to reload to get extra data (added by someone else)
      if (data.geojson) {
        this.clear()
        this.fromGeoJSON(data.geojson)
        delete data.geojson
      }
      delete data.id
      delete data._referenceVersion
      this.updateOptions(data)

      this.setReferenceVersion({ response, sync: true })

      this.backupOptions()
      this.backupData()
      this.connectToMap()
      this._loaded = true
      this.redraw() // Needed for reordering features
      return true
    }
  }

  async saveDelete() {
    if (this.createdOnServer) {
      await this._umap.server.post(this.getDeleteUrl())
    }
    delete this._umap.datalayers[stamp(this)]
    return true
  }

  getName() {
    return this.options.name || translate('Untitled layer')
  }

  tableEdit() {
    if (!this.isVisible()) return
    const editor = new TableEditor(this._umap, this, this._leafletMap)
    editor.open()
  }

  getFilterKeys() {
    // This keys will be used to filter feature from the browser text input.
    // By default, it will we use the "name" property, which is also the one used as label in the features list.
    // When map owner has configured another label or sort key, we try to be smart and search in the same keys.
    if (this._umap.properties.filterKey) return this._umap.properties.filterKey
    if (this.getOption('labelKey')) return this.getOption('labelKey')
    if (this._umap.properties.sortKey) return this._umap.properties.sortKey
    return 'displayName'
  }

  renderLegend() {
    for (const container of document.querySelectorAll(
      `.${this.cssId} .datalayer-legend`
    )) {
      container.innerHTML = ''
      if (this.layer.renderLegend) return this.layer.renderLegend(container)
      const color = DomUtil.create('span', 'datalayer-color', container)
      color.style.backgroundColor = this.getColor()
    }
  }

  renderToolbox(container) {
    const toggle = DomUtil.createButtonIcon(
      container,
      'icon-eye',
      translate('Show/hide layer')
    )
    const zoomTo = DomUtil.createButtonIcon(
      container,
      'icon-zoom',
      translate('Zoom to layer extent')
    )
    const edit = DomUtil.createButtonIcon(
      container,
      'icon-edit show-on-edit',
      translate('Edit')
    )
    const table = DomUtil.createButtonIcon(
      container,
      'icon-table show-on-edit',
      translate('Edit properties in a table')
    )
    const remove = DomUtil.createButtonIcon(
      container,
      'icon-delete show-on-edit',
      translate('Delete layer')
    )
    if (this.isReadOnly()) {
      DomUtil.addClass(container, 'readonly')
    } else {
      DomEvent.on(edit, 'click', this.edit, this)
      DomEvent.on(table, 'click', this.tableEdit, this)
      DomEvent.on(
        remove,
        'click',
        function () {
          if (!this.isVisible()) return
          this._umap.dialog
            .confirm(translate('Are you sure you want to delete this layer?'))
            .then(() => {
              this._delete()
            })
        },
        this
      )
    }
    DomEvent.on(toggle, 'click', this.toggle, this)
    DomEvent.on(zoomTo, 'click', this.zoomTo, this)
    container.classList.add(this.getHidableClass())
    container.classList.toggle('off', !this.isVisible())
  }

  getHidableElements() {
    return document.querySelectorAll(`.${this.getHidableClass()}`)
  }

  getHidableClass() {
    return `show_with_datalayer_${stamp(this)}`
  }

  propagateDelete() {
    const els = this.getHidableElements()
    for (const el of els) {
      DomUtil.remove(el)
    }
  }

  propagateRemote() {
    const els = this.getHidableElements()
    for (const el of els) {
      el.classList.toggle('remotelayer', this.isRemoteLayer())
    }
  }

  propagateHide() {
    const els = this.getHidableElements()
    for (let i = 0; i < els.length; i++) {
      DomUtil.addClass(els[i], 'off')
    }
  }

  propagateShow() {
    const els = this.getHidableElements()
    for (let i = 0; i < els.length; i++) {
      DomUtil.removeClass(els[i], 'off')
    }
  }
}

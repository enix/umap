import { DomUtil } from '../../vendors/leaflet/leaflet-src.esm.js'
import { translate } from './i18n.js'
import { uMapAlert as Alert } from '../components/alerts/alert.js'
import { ServerStored } from './saving.js'
import * as Utils from './utils.js'

// Dedicated object so we can deal with a separate dirty status, and thus
// call the endpoint only when needed, saving one call at each save.
export class MapPermissions extends ServerStored {
  constructor(umap) {
    super()
    this.setProperties(umap.properties.permissions)
    this._umap = umap
    this._isDirty = false
  }

  setProperties(properties) {
    this.properties = Object.assign(
      {
        owner: null,
        team: null,
        editors: [],
        share_status: null,
        edit_status: null,
      },
      properties
    )
  }

  render() {
    this._umap.render(['properties.permissions'])
  }

  isOwner() {
    return Boolean(this._umap.properties.user?.is_owner)
  }

  isAnonymousMap() {
    return !this._umap.properties.permissions.owner
  }

  _editAnonymous(container) {
    const fields = []
    if (this.isOwner()) {
      fields.push([
        'properties.edit_status',
        {
          handler: 'IntSelect',
          label: translate('Who can edit'),
          selectOptions: this._umap.properties.edit_statuses,
        },
      ])
      const builder = new U.FormBuilder(this, fields)
      const form = builder.build()
      container.appendChild(form)

      if (this.properties.anonymous_edit_url) {
        DomUtil.createCopiableInput(
          container,
          translate('Secret edit link:'),
          this.properties.anonymous_edit_url
        )
      }

      if (this._umap.properties.user?.id) {
        // We have a user, and this user has come through here, so they can edit the map, so let's allow to own the map.
        // Note: real check is made on the back office anyway.
        const advancedActions = DomUtil.createFieldset(
          container,
          translate('Advanced actions')
        )
        const advancedButtons = DomUtil.create('div', 'button-bar', advancedActions)
        DomUtil.createButton(
          'button',
          advancedButtons,
          translate('Attach the map to my account'),
          this.attach,
          this
        )
      }
    }
  }

  _editWithOwner(container) {
    const topFields = []
    const collaboratorsFields = []
    const fieldset = Utils.loadTemplate(
      `<fieldset class="separator"><legend>${translate('Map')}</legend></fieldset>`
    )
    container.appendChild(fieldset)
    if (this.isOwner()) {
      topFields.push([
        'properties.edit_status',
        {
          handler: 'IntSelect',
          label: translate('Who can edit'),
          selectOptions: this._umap.properties.edit_statuses,
        },
      ])
      topFields.push([
        'properties.share_status',
        {
          handler: 'IntSelect',
          label: translate('Who can view'),
          selectOptions: this._umap.properties.share_statuses,
        },
      ])
      collaboratorsFields.push([
        'properties.owner',
        { handler: 'ManageOwner', label: translate("Map's owner") },
      ])
      if (this._umap.properties.user?.teams?.length) {
        collaboratorsFields.push([
          'properties.team',
          {
            handler: 'ManageTeam',
            label: translate('Attach map to a team'),
            teams: this._umap.properties.user.teams,
          },
        ])
      }
    }
    collaboratorsFields.push([
      'properties.editors',
      { handler: 'ManageEditors', label: translate("Map's editors") },
    ])

    const builder = new U.FormBuilder(this, topFields)
    const form = builder.build()
    container.appendChild(form)
    if (collaboratorsFields.length) {
      const fieldset = Utils.loadTemplate(
        `<fieldset class="separator"><legend>${translate('Manage collaborators')}</legend></fieldset>`
      )
      container.appendChild(fieldset)
      const builder = new U.FormBuilder(this, collaboratorsFields)
      const form = builder.build()
      container.appendChild(form)
    }
  }

  _editDatalayers(container) {
    if (this._umap.hasLayers()) {
      const fieldset = Utils.loadTemplate(
        `<fieldset class="separator"><legend>${translate('Datalayers')}</legend></fieldset>`
      )
      container.appendChild(fieldset)
      this._umap.eachDataLayer((datalayer) => {
        datalayer.permissions.edit(fieldset)
      })
    }
  }

  edit() {
    if (this._umap.properties.editMode !== 'advanced') return
    if (!this._umap.id) {
      Alert.info(translate('Please save the map first'))
      return
    }
    const container = DomUtil.create('div', 'permissions-panel')
    DomUtil.createTitle(container, translate('Update permissions'), 'icon-key')
    if (this.isAnonymousMap()) this._editAnonymous(container)
    else this._editWithOwner(container)
    this._editDatalayers(container)
    this._umap.editPanel.open({ content: container, className: 'dark' })
  }

  async attach() {
    const [data, response, error] = await this._umap.server.post(this.getAttachUrl())
    if (!error) {
      this.properties.owner = this._umap.properties.user
      Alert.success(translate('Map has been attached to your account'))
      this._umap.editPanel.close()
    }
  }

  async save() {
    if (!this.isDirty) return
    const formData = new FormData()
    if (!this.isAnonymousMap() && this.properties.editors) {
      const editors = this.properties.editors.map((u) => u.id)
      for (let i = 0; i < this.properties.editors.length; i++)
        formData.append('editors', this.properties.editors[i].id)
    }
    if (this.isOwner() || this.isAnonymousMap()) {
      formData.append('edit_status', this.properties.edit_status)
    }
    if (this.isOwner()) {
      formData.append('owner', this.properties.owner?.id)
      formData.append('team', this.properties.team?.id || '')
      formData.append('share_status', this.properties.share_status)
    }
    const [data, response, error] = await this._umap.server.post(
      this.getUrl(),
      {},
      formData
    )
    if (!error) {
      this.commit()
      return true
    }
  }

  getUrl() {
    return this._umap.urls.get('map_update_permissions', {
      map_id: this._umap.id,
    })
  }

  getAttachUrl() {
    return this._umap.urls.get('map_attach_owner', {
      map_id: this._umap.id,
    })
  }

  commit() {
    this._umap.properties.permissions = Object.assign(
      {},
      this._umap.properties.permissions,
      this.properties
    )
  }

  getShareStatusDisplay() {
    if (this._umap.properties.share_statuses) {
      return Object.fromEntries(this._umap.properties.share_statuses)[
        this.properties.share_status
      ]
    }
  }
}

export class DataLayerPermissions extends ServerStored {
  constructor(umap, datalayer) {
    super()
    this._umap = umap
    this.properties = Object.assign(
      {
        edit_status: null,
      },
      datalayer.options.permissions
    )

    this.datalayer = datalayer
  }

  edit(container) {
    const fields = [
      [
        'properties.edit_status',
        {
          handler: 'IntSelect',
          label: translate('Who can edit "{layer}"', {
            layer: this.datalayer.getName(),
          }),
          selectOptions: this._umap.properties.datalayer_edit_statuses,
        },
      ],
    ]
    const builder = new U.FormBuilder(this, fields, {
      className: 'umap-form datalayer-permissions',
    })
    const form = builder.build()
    container.appendChild(form)
  }

  getUrl() {
    return this._umap.urls.get('datalayer_permissions', {
      map_id: this._umap.id,
      pk: this.datalayer.id,
    })
  }

  async save() {
    if (!this.isDirty) return
    const formData = new FormData()
    formData.append('edit_status', this.properties.edit_status)
    const [data, response, error] = await this._umap.server.post(
      this.getUrl(),
      {},
      formData
    )
    if (!error) {
      this.commit()
      return true
    }
  }

  commit() {
    this.datalayer.options.permissions = Object.assign(
      {},
      this.datalayer.options.permissions,
      this.properties
    )
  }
}

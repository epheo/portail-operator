import './TopologyPage.css';

export const TopologyLegend: React.FC = () => {
  return (
    <div className="portail-legend">
      <div className="portail-legend__section">
        <span className="portail-legend__section-title">Networks:</span>
        <span className="portail-legend__item">
          <span className="portail-legend__swatch" style={{ background: '#0066cc' }} />
          Default
        </span>
        <span className="portail-legend__item">
          <span className="portail-legend__swatch" style={{ background: '#6753ac' }} />
          UDN
        </span>
        <span className="portail-legend__item">
          <span className="portail-legend__swatch" style={{ background: '#0066cc' }} />
          External / LB
        </span>
      </div>

      <div className="portail-legend__section">
        <span className="portail-legend__section-title">Gateways:</span>
        <span className="portail-legend__item">
          <span className="portail-legend__line" style={{ background: '#3e8635' }} />
          Programmed
        </span>
        <span className="portail-legend__item">
          <span className="portail-legend__line portail-legend__line--dashed" />
          Accepted
        </span>
        <span className="portail-legend__item">
          <span className="portail-legend__line portail-legend__line--dotted" />
          Not ready
        </span>
      </div>

      <div className="portail-legend__section">
        <span className="portail-legend__section-title">Routes:</span>
        <span className="portail-legend__item">
          <span className="portail-legend__swatch" style={{ background: '#009596' }} />
          HTTPRoute
        </span>
        <span className="portail-legend__item">
          <span className="portail-legend__swatch" style={{ background: '#8476D1' }} />
          GRPCRoute
        </span>
        <span className="portail-legend__item">
          <span className="portail-legend__swatch" style={{ background: '#C46100' }} />
          TCPRoute
        </span>
        <span className="portail-legend__item">
          <span className="portail-legend__swatch" style={{ background: '#EC7A08' }} />
          TLSRoute
        </span>
        <span className="portail-legend__item">
          <span className="portail-legend__swatch" style={{ background: '#A18FFF' }} />
          UDPRoute
        </span>
      </div>
    </div>
  );
};
